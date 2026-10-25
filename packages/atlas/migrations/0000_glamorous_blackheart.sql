CREATE TABLE `benchmark_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`provenance` text NOT NULL,
	`source_ref` text NOT NULL,
	`sha256` text NOT NULL,
	`relative_path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `benchmark_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_acquisition` ON `benchmark_artifacts` (`attempt_id`,`kind`,`source_ref`,`sha256`);--> statement-breakpoint
CREATE TABLE `benchmark_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`account_alias` text NOT NULL,
	`run_id` text,
	`capability_id` text,
	`metrics_json` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `benchmark_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `benchmark_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`config_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `benchmark_reports` (
	`attempt_id` text NOT NULL,
	`revision` integer NOT NULL,
	`body_json` text NOT NULL,
	`thread_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `benchmark_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_revision` ON `benchmark_reports` (`attempt_id`,`revision`);