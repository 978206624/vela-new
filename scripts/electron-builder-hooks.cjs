"use strict";

const { execFile } = require("child_process");
const { copyFile, rm } = require("fs/promises");
const os = require("os");
const path = require("path");
const { appBuilderPath } = require("app-builder-bin");

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function execFileWithRetry(file, args, retryCount = 5) {
  let lastError;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await execFileAsync(file, args);
    } catch (error) {
      lastError = error;

      if (attempt === retryCount) {
        break;
      }

      await delay(500 * (attempt + 1));
    }
  }

  throw lastError;
}

exports.afterExtract = async function afterExtract(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const { packager } = context;
  const appInfo = packager.appInfo;
  const winOptions = packager.platformSpecificBuildOptions || {};
  const electronBranding = packager.config.electronBranding || {};
  const electronProjectName = electronBranding.projectName || "electron";
  const executablePath = path.join(context.appOutDir, `${electronProjectName}.exe`);
  const iconPath = await packager.getIconPath();

  const args = [
    executablePath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "LegalCopyright",
    appInfo.copyright,
    "--set-file-version",
    appInfo.shortVersion || appInfo.buildVersion,
    "--set-product-version",
    appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    "--set-version-string",
    "InternalName",
    appInfo.productFilename,
    "--set-version-string",
    "OriginalFilename",
    "",
  ];

  if (winOptions.requestedExecutionLevel && winOptions.requestedExecutionLevel !== "asInvoker") {
    args.push("--set-requested-execution-level", winOptions.requestedExecutionLevel);
  }

  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }

  if (winOptions.legalTrademarks) {
    args.push("--set-version-string", "LegalTrademarks", winOptions.legalTrademarks);
  }

  if (iconPath) {
    args.push("--set-icon", iconPath);
  }

  const tempExecutablePath = path.join(
    os.tmpdir(),
    `vela-electron-rcedit-${process.pid}-${Date.now()}.exe`,
  );

  try {
    await copyFile(executablePath, tempExecutablePath);

    const tempArgs = [...args];
    tempArgs[0] = tempExecutablePath;

    await execFileWithRetry(appBuilderPath, ["rcedit", "--args", JSON.stringify(tempArgs)]);
    await copyFile(tempExecutablePath, executablePath);
  } finally {
    await rm(tempExecutablePath, { force: true });
  }
};
