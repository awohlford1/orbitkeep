export interface RuntimeEnvironmentIssue {
  code: "WSL_WINDOWS_NODE_MISMATCH";
  message: string;
}

export function detectRuntimeEnvironmentIssue(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): RuntimeEnvironmentIssue | undefined {
  const launchedFromWsl = typeof environment.WSL_DISTRO_NAME === "string" || typeof environment.WSL_INTEROP === "string";
  if (platform === "win32" && launchedFromWsl) return {
    code: "WSL_WINDOWS_NODE_MISMATCH",
    message: "Orbitkeep was launched by Windows Node from a WSL shell. Use the Linux node, npm, and npx executables inside WSL, then retry.",
  };
  return undefined;
}

export function assertSupportedRuntimeEnvironment(platform = process.platform, environment = process.env): void {
  const issue = detectRuntimeEnvironmentIssue(platform, environment);
  if (issue) throw Object.assign(new Error(issue.message), { code: issue.code });
}
