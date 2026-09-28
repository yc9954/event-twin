# NemoClaw source provenance

Event Twin is an independent web adaptation. It is not an official NVIDIA product or a supported upstream NemoClaw integration.

## Upstream identity

- Repository: https://github.com/NVIDIA/NemoClaw
- Revision: `3c668364eeb9b94dcd2e0a553382aa0e16e3745e`
- Commit date: 2026-09-27
- Commit subject: `fix(sandbox): preserve Deep Agents state during Error recovery (#11293)`
- Retrieved: 2026-09-28
- Local reference checkout: `work/nemoclaw-reference` at the workspace root.
- License: Apache-2.0. The unmodified upstream license is included as [LICENSE](LICENSE).
- Copyright: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

## Reused source

`runtime-context.mjs` is a modified JavaScript adaptation of:

https://github.com/NVIDIA/NemoClaw/blob/3c668364eeb9b94dcd2e0a553382aa0e16e3745e/nemoclaw/src/runtime-context.ts

The reusable structure is the runtime summary, context formatter, and `before_prompt_build` hook that returns `prependSystemContext`. The source-level SPDX copyright and license notices must remain in the adapted file, together with a notice identifying the modifications.

The Event Twin adaptation replaces the upstream OpenShell-specific context and persisted-state dependency with an explicit description of the application's actual local runtime and capabilities. It must not assert that a local-direct process is running inside an OpenShell sandbox, that network access is enforced by OpenShell, or that an OpenShell operator approval request is created.

The upstream `blueprint/state.ts` implementation is not transplanted. In the reference source, even `loadState()` can create a directory below `~/.nemoclaw/state`; Event Twin must not use this implicit host-state path.

## Integration boundary

- The runtime-context code provides model guidance. It does not enforce permissions or create an isolation boundary.
- Event Twin's own server-side tool allowlist, approval checks, data consent, and revision guards remain responsible for application authorization.
- Event Twin's declarative agent blueprint and web runtime readout are local application code. They are not the upstream sandbox blueprint schema or proof of OpenShell readiness.
- No upstream CLI, installer, onboarding script, container image, host security configuration, credential store, or lifecycle controller is transplanted by this adaptation.
- OpenShell integration must remain identified as disconnected unless a separately configured and verified runtime connection exists.
- The source checkout alone does not demonstrate NVIDIA model inference, OpenShell isolation, or execution through a supported NemoClaw agent runtime.

## Reference-only upstream components

These sources explain the architecture but are not included as runtime dependencies by this adaptation:

- `nemoclaw-blueprint/blueprint.yaml` and `schemas/blueprint.schema.json`: versioned sandbox, inference, and policy declarations.
- `src/lifecycle/index.ts`: the public headless lifecycle API.
- `src/lib/domain/lifecycle/` and `src/lib/actions/lifecycle/observe-hermes.ts`: Hermes-specific planning and verified read-only observation.
- `nemoclaw/src/shared/openshell-policy-boundary.cts`: OpenShell policy parsing and command-result contracts.

The lifecycle API at this revision is specific to Hermes 0.21.3 and OpenShell 0.0.116. It does not create or mutate a sandbox and requires an independently authenticated live observer. It must not be repurposed to label Event Twin's local process as a ready Hermes sandbox.

## Reproduction and review

The reference repository was cloned without installing dependencies or running setup, onboarding, containers, inference, or policy commands. Its checkout was clean after inspection. No upstream test suite or live NemoClaw runtime validation was performed during the source review.

When updating the adapted module, record the new upstream revision, retain the license and attribution, and review the changes against the real execution boundary. A source reuse claim and a live runtime integration claim are different.
