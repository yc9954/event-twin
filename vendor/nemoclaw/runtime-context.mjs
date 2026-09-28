// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Modified for Event Twin on 2026-09-28 from NemoClaw's runtime-context.ts.
// Changes: remove host state reads and OpenClaw types; inject truthful, request-
// scoped local runtime capabilities instead of asserting an OpenShell sandbox.
// Retains the summary -> context formatter -> before_prompt_build hook boundary.
// This module provides model guidance, NOT OS sandbox enforcement.

export function getRuntimeSummary(config) {
  return {
    runtimeName: config.runtimeName,
    runtimePhase: config.runtimePhase,
    sandboxConnected: config.sandboxConnected === true,
    networkLines: [...config.networkLines],
    filesystemLines: [...config.filesystemLines],
    behaviorLines: [...config.behaviorLines],
  };
}

export function buildRuntimeContextText(summary) {
  const lines = [
    '<event-twin-runtime>',
    `Runtime: ${summary.runtimeName}.`,
    summary.sandboxConnected ? 'This web application runs inside an OpenShell sandbox with observed Linux process restrictions.' : 'This web application is not running inside an OpenShell sandbox.',
    summary.runtimePhase ? `Current runtime phase: ${summary.runtimePhase}.` : null,
    'Network policy:',
    ...summary.networkLines.map(line => `- ${line}`),
    'Filesystem policy:',
    ...summary.filesystemLines.map(line => `- ${line}`),
    'Behavior:',
    ...summary.behaviorLines.map(line => `- ${line}`),
    '- Do not claim unrestricted host or internet access. Rely on actual results from the provided tools.',
    '- Distinguish application permission denials from provider, network, quota and validation errors. Do not invent an OpenShell approval request.',
    '</event-twin-runtime>',
  ].filter(Boolean);
  return lines.join('\n');
}

export function registerRuntimeContext(api, config) {
  api.on('before_prompt_build', () => ({
    prependSystemContext: buildRuntimeContextText(getRuntimeSummary(config)),
  }));
}
