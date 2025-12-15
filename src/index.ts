#!/usr/bin/env node

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  progress,
  text,
} from "@clack/prompts";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import { Project } from "ts-morph";
import { migrateZodV3ToV4 } from "./migrate.ts";

const execAsync = promisify(exec);

intro(`🏗️  Let's migrate Zod from v3 to v4`);

// Check if an argument was provided after calling the script
// Ex: npx zod-v3-to-v4 path/to/your/tsconfig.json
const args = process.argv.slice(2);
const tsConfigFilePathParam = args[0];
if (tsConfigFilePathParam) {
  const isValid = validateTsConfigPath(tsConfigFilePathParam);
  if (isValid.success) {
    // If everything is valid, run the migration without question
    await runMigration(tsConfigFilePathParam);
    process.exit(0);
  }

  log.warn(
    `"${tsConfigFilePathParam}" is not a valid tsconfig file. ${isValid.reason}

Let's do it interactively!`,
  );
}

// Check if the git working directory is clean
const { stdout } = await execAsync("git status --porcelain");
const isGitDirty = stdout.trim().length > 0;
if (isGitDirty) {
  const shouldContinue = await confirm({
    message: "Your git working directory is dirty. Continue?",
  });
  if (!shouldContinue || isCancel(shouldContinue)) {
    cancel("Migration cancelled.");
    process.exit(0);
  }
}

// Ask the user for the tsconfig file path
const tsConfigFilePath = await text({
  message: "Where is your tsconfig.json?",
  placeholder: `path/to/your/tsconfig.json`,
  initialValue: tsConfigFilePathParam ?? "tsconfig.json",
  validate(value) {
    if (!value) {
      return "Please enter a file path";
    }

    const isValid = validateTsConfigPath(value);
    if (!isValid.success) {
      return isValid.reason;
    }
  },
});
if (isCancel(tsConfigFilePath)) {
  cancel("Migration cancelled.");
  process.exit(0);
}

await runMigration(tsConfigFilePath);

async function runMigration(tsConfigFilePath: string) {
  const project = new Project({
    tsConfigFilePath,
    skipFileDependencyResolution: true,
  });
  const allFiles = project.getSourceFiles();

  log.info(`Updating v3`);

  // Sort files alphabetically by file path
  const filesToProcess = allFiles.sort((a, b) =>
    a.getFilePath().localeCompare(b.getFilePath()),
  );

  // Load processed files from progress file
  const progressFilePath = ".zod-migration-progress.json";
  const processedFiles = loadProcessedFiles(progressFilePath);

  let skippedFilesCount = 0;
  let processedFilesCount = 0;
  const progressBar = progress({ max: filesToProcess.length });
  progressBar.start("Processing files...");

  for (const sourceFile of filesToProcess) {
    const filePath = sourceFile.getFilePath();

    // Check if file has already been processed
    if (processedFiles.has(filePath)) {
      // log.info(`Skipping ${filePath} (already processed)`);
      skippedFilesCount++;
      processedFilesCount++;
      progressBar.advance(
        1,
        `Processed ${processedFilesCount}/${filesToProcess.length} files (${skippedFilesCount} skipped)`,
      );
      await wait(0);
      continue;
    }

    try {
      // log.info(`Migrating ${filePath}`);
      migrateZodV3ToV4(sourceFile);
      await sourceFile.save();

      // Mark file as processed
      processedFiles.add(filePath);
      saveProcessedFiles(progressFilePath, processedFiles);
    } catch (err) {
      let message = `Failed to migrate ${filePath}`;
      if (err instanceof Error) {
        message += `\nReason: ${err.message}`;
      }
      message += `\n\nPlease report this at https://github.com/nicoespeon/zod-v3-to-v4/issues`;
      log.error(message);
    }

    processedFilesCount++;
    progressBar.advance(
      1,
      `Processed ${processedFilesCount}/${filesToProcess.length} files (${skippedFilesCount} skipped)`,
    );

    // Wait the next tick to let the progress bar update
    await wait(0);
  }

  // Only save at the end so we can cancel the migration in-flight.
  // Also, it's much faster than saving each file individually.
  await project.save();

  const skippedMessage =
    skippedFilesCount > 0
      ? ` (${skippedFilesCount} files were skipped as they were already processed)`
      : "";
  progressBar.stop(`All files have been migrated.${skippedMessage}`);
  outro(
    `You're all set!

ℹ️  If the migration missed something or did something wrong, please report it at https://github.com/nicoespeon/zod-v3-to-v4/issues`,
  );
}

function validateTsConfigPath(path: string) {
  if (!path.endsWith(".json")) {
    return {
      success: false,
      reason: "Please enter a valid tsconfig.json file path.",
    } as const;
  }

  if (!fs.existsSync(path)) {
    return {
      success: false,
      reason: "File not found.",
    } as const;
  }

  return { success: true } as const;
}

function loadProcessedFiles(progressFilePath: string): Set<string> {
  try {
    if (fs.existsSync(progressFilePath)) {
      const content = fs.readFileSync(progressFilePath, "utf-8");
      const data = JSON.parse(content);
      return new Set(data.processedFiles || []);
    }
  } catch (err) {
    // If file doesn't exist or is invalid, start fresh
    log.warn("Could not load progress file, starting fresh");
  }
  return new Set<string>();
}

function saveProcessedFiles(
  progressFilePath: string,
  processedFiles: Set<string>,
): void {
  try {
    const data = {
      processedFiles: Array.from(processedFiles).sort(),
    };
    fs.writeFileSync(progressFilePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    log.warn(`Could not save progress to ${progressFilePath}`);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
