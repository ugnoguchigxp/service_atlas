import { chromium, type BrowserContext, type Page, type Request } from 'playwright';
import type { z } from 'zod';
import { observationSchema, type BenchmarkCase, type CollectionMetric } from './contracts.ts';
import { validatePlan, type ExplorationPlan, type PlanStep } from './plan.ts';
import { serializedEvidence } from './redaction.ts';

type Observation = z.infer<typeof observationSchema>;
type Sink = {observation: (value: Observation) => void; metric: (value: CollectionMetric) => void};
const timeoutMs = 10_000;
const maxRequests = 100;
const maxBatchMs = 90_000;

function permitted(benchmark: BenchmarkCase, url: string, method: string) {
  const parsed = new URL(url);
  return parsed.origin === new URL(benchmark.targetUrl).origin && !parsed.username && !parsed.password && ['GET', 'HEAD'].includes(method);
}

async function guard(context: BrowserContext, benchmark: BenchmarkCase, gap: (reason: string) => void) {
  let requests = 0;
  const reserve = () => ++requests <= maxRequests;
  await context.route('**/*', async route => {
    const request = route.request();
    if (!permitted(benchmark, request.url(), request.method())) {gap('対象外originまたはGET/HEAD以外の通信を遮断'); return route.abort();}
    if (!reserve()) {gap('バッチの通信上限100件に到達'); return route.abort();}
    // Chromium does not route every redirect hop. Fetch once without following
    // redirects, then pass the real response through; abort redirects explicitly.
    try {
      const response = await route.fetch({maxRedirects: 0, timeout: timeoutMs});
      try {
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          gap('ブラウザの自動リダイレクトを停止。転送先は未取得');
          await route.abort();
        } else await route.fulfill({response});
      } finally {await response.dispose();}
    } catch {
      gap('ブラウザ通信の取得に失敗');
      await route.abort().catch(() => {});
    }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  return reserve;
}

async function inBrowser<T>(operation: (context: BrowserContext) => Promise<T>) {
  const browser = await chromium.launch({headless: true});
  const timer = setTimeout(() => {void browser.close().catch(() => {});}, maxBatchMs);
  try {
    const context = await browser.newContext({serviceWorkers: 'block', acceptDownloads: false});
    context.setDefaultTimeout(timeoutMs);
    context.setDefaultNavigationTimeout(timeoutMs);
    return await operation(context);
  } finally {clearTimeout(timer); await browser.close();}
}

/** Bootstrap only the entry page; link and control meaning is left to the planner. */
export async function inspectTarget(benchmark: BenchmarkCase) {
  return inBrowser(async context => {
    const gaps = new Set<string>();
    await guard(context, benchmark, reason => gaps.add(reason));
    const page = await context.newPage();
    await page.goto(benchmark.targetUrl, {waitUntil: 'domcontentloaded'});
    const snapshot = await page.evaluate(() => {
      const allLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
      const allControls = [...document.querySelectorAll<HTMLElement>('button,input,select,[role="button"],[role="tab"]')];
      const text = document.body.innerText;
      return {
        url: location.href, title: document.title, text: text.slice(0, 24000),
        links: allLinks.slice(0, 100).map(node => ({text: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 200), url: node.href})),
        controls: allControls.slice(0, 80).map(node => ({tag: node.tagName, role: node.getAttribute('role'), text: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 200), name: node.getAttribute('name'), placeholder: node.getAttribute('placeholder')})),
        limits: {textOmitted: text.length > 24000, linksOmitted: Math.max(0, allLinks.length - 100), controlsOmitted: Math.max(0, allControls.length - 80)},
      };
    });
    return {...snapshot, gaps: [...gaps]};
  });
}

function locate(page: Page, locator: Extract<PlanStep, {action: 'click'}>['locator']) {
  if (locator.by === 'role') return page.getByRole(locator.role, {name: locator.name, exact: true});
  if (locator.by === 'label') return page.getByLabel(locator.value, {exact: true});
  if (locator.by === 'placeholder') return page.getByPlaceholder(locator.value, {exact: true});
  if (locator.by === 'text') return page.getByText(locator.value, {exact: true});
  return page.locator(locator.value);
}

/** Executor has no model dependency. Injectable context permits real Chromium fixture tests. */
export async function executeBatch(context: BrowserContext, benchmark: BenchmarkCase, value: ExplorationPlan, sink: Sink) {
  const plan = validatePlan(benchmark, value);
  const pending = new Set<Promise<void>>();
  const starts = new Map<Request, number>();
  let captures = 0;
  let omitted = 0;
  const gap = (reason: string) => {
    if (omitted++ < 10) sink.metric({kind: 'capture-gap', status: 'unavailable', durationMs: 0, bytes: 0, reason});
  };
  const reserveRequest = await guard(context, benchmark, gap);
  context.on('request', request => starts.set(request, performance.now()));
  async function persist(value: Observation) {
    const bytes = Buffer.byteLength(serializedEvidence(value));
    if (bytes > 256_000) {gap('本文が保存上限256KBを超過。切り詰めず未取得として記録'); return;}
    sink.observation(value); captures++;
    sink.metric({kind: value.probeId ?? 'browser-response', status: 'ok', durationMs: value.durationMs, bytes, reason: null});
  }
  const finished = (request: Request) => {
    if (!plan.captureResourceTypes.some(type => type === request.resourceType()) || !permitted(benchmark, request.url(), request.method())) {starts.delete(request); return;}
    const started = starts.get(request) ?? performance.now(); starts.delete(request);
    const task = (async () => {
      const response = await request.response();
      if (!response) {gap('応答を取得できなかった通信あり'); return;}
      const body = await response.body();
      await persist(observationSchema.parse({request: {method: request.method(), url: request.url(), headers: await request.allHeaders(), body: request.postData()},
        response: {status: response.status(), headers: await response.allHeaders(), body: new TextDecoder('utf-8', {fatal: true}).decode(body)},
        captureState: 'complete', observedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started)}));
    })().catch(() => gap('応答本文の取得・UTF-8変換・保存に失敗。完全な観測には含めない'));
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  const failed = (request: Request) => {
    starts.delete(request);
    if (plan.captureResourceTypes.some(type => type === request.resourceType())) gap('ブラウザ通信が完了しなかったため本文は未取得');
  };
  context.on('requestfinished', finished); context.on('requestfailed', failed);
  const page = await context.newPage();
  page.on('dialog', dialog => {void dialog.dismiss();});
  let stepFailed = false;
  try {
    for (const [index, step] of plan.steps.entries()) {
      try {
        if (step.action === 'request') {
          if (!reserveRequest()) {gap('バッチの通信上限100件に到達'); stepFailed = true; break;}
          // APIRequestContext does not pass through browser routes; validate the URL
          // above and disable redirect following to retain the same origin boundary.
          const started = performance.now();
          const response = await context.request.fetch(step.url, {method: step.method, maxRedirects: 0, timeout: timeoutMs});
          try {
            await persist(observationSchema.parse({probeId: `step-${index + 1}`, request: {method: step.method, url: step.url},
              response: {status: response.status(), headers: response.headers(), body: new TextDecoder('utf-8', {fatal: true}).decode(await response.body())},
              captureState: 'complete', observedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started)}));
          } finally {await response.dispose();}
        } else if (step.action === 'navigate') await page.goto(step.url, {waitUntil: 'domcontentloaded'});
        else if (step.action === 'click') await locate(page, step.locator).click({timeout: timeoutMs});
        else await locate(page, step.locator).fill(step.value, {timeout: timeoutMs});
        if (plan.settleMs) await page.waitForTimeout(plan.settleMs);
      } catch {
        sink.metric({kind: `step-${index + 1}`, status: 'unavailable', durationMs: 0, bytes: 0, reason: '計画の操作を完了できなかったため、後続操作を停止。自動再計画はしません'});
        stepFailed = true; break;
      }
    }
    // Stop the observation window, then drain all bodies already completed.
    context.off('requestfinished', finished); context.off('requestfailed', failed);
    if ([...starts].some(([request]) => plan.captureResourceTypes.some(type => type === request.resourceType()))) gap('観測終了時に未完了の通信あり');
    await Promise.all([...pending]);
    return {captures, gaps: omitted, stepFailed, observationWindowClosed: true};
  } finally {
    context.off('requestfinished', finished); context.off('requestfailed', failed);
    await page.close();
  }
}

export function captureBatch(benchmark: BenchmarkCase, plan: ExplorationPlan, sink: Sink) {
  return inBrowser(context => executeBatch(context, benchmark, plan, sink));
}
