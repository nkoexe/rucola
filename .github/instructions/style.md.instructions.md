---
description: always use the provided coding style and guidelines when generating code, answering questions, or reviewing changes
---
# Agent Working Style & Behaviour

## General approach

- Act like a senior engineer working on a small personal product, not an enterprise team.
- Understand the existing code before changing it. Inspect relevant files, architecture, and dependencies first.
- Prefer simple, obvious solutions over clever abstractions.
- Make reasonable decisions independently. Do not ask for confirmation for every implementation detail.
- Ask the user only when a decision is genuinely product-defining, destructive, ambiguous, or impossible to infer from the repository/spec.
- Do not invent requirements that are not in the product specification.
- If something is explicitly out of scope, do not implement it "for completeness".
- Keep the project easy for one person to understand and maintain.

## Scope discipline

- Work only on the requested task and its necessary supporting changes.
- Avoid unrelated refactors.
- Do not rewrite working code merely because another style would be preferred.
- Do not add dependencies unless they provide a clear benefit.
- Before introducing a library, check whether the existing platform/toolchain already provides what is needed.
- Avoid premature infrastructure for hypothetical future requirements.
- At the same time, do not make shortcuts that directly conflict with documented architectural invariants.

## Making technical decisions

- When multiple approaches are viable, choose the simplest one that satisfies the requirements.
- Prefer platform-native Android solutions when they are good enough.
- Prefer stable, well-supported libraries over obscure or experimental ones.
- Do not optimize for theoretical scalability. Optimize for correctness, maintainability, and a good user experience.
- Future synchronization, offline operation, widgets, and media handling matter architecturally, but they should not result in unnecessary abstractions in the MVP.
- If a technical decision has meaningful future consequences, document the decision briefly in the PR rather than building an elaborate abstraction around it.

## Code quality

- Write production-quality code even for prototypes.
- Favor readable names and straightforward control flow.
- Keep functions and classes reasonably focused.
- Avoid deeply nested logic.
- Avoid giant files and god classes.
- Keep UI code readable; extract reusable components when they are actually reused or clearly represent a meaningful design component.
- Avoid abstraction for abstraction's sake.
- Do not duplicate important business rules across UI, persistence, and networking layers.
- Keep domain rules testable without requiring Android UI infrastructure where practical.
- Comments should explain *why*, not restate what the code obviously does.
- Do not leave TODOs for things that are required for the current task.
- If something is intentionally deferred, make the reason clear.

## Product behaviour

- Treat the product specification as authoritative.
- Preserve the core feeling of Rucola: private, cute, personal, playful, slightly imperfect, and made for two people.
- Do not gradually turn the UI into a generic Android/Material application.
- The UI should feel designed, not merely assembled from default components.
- Prefer expressive layouts, playful spacing, organic shapes, and intentional visual hierarchy.
- Avoid unnecessary UI chrome, settings, menus, confirmation dialogs, and configuration.
- Every screen should have a clear purpose.
- Prefer showing the important thing immediately rather than making the user navigate to it.
- Do not add gamification or engagement mechanics unless explicitly requested.
- Never introduce social-media/chat-app conventions that conflict with the product concept.

## Visual implementation

- Use the Figma design as the visual reference, not as a requirement to reproduce every pixel literally.
- Preserve the visual language even when adapting it to Android.
- Do not replace the design with stock Material 3 screens.
- Establish reusable design tokens for typography, spacing, shapes, and colors rather than scattering magic values throughout the UI.
- Keep the pastel/cutesy palette and large playful shapes.
- Geometry may intentionally be imperfect or organic.
- Pixel-art assets supplied by the owner should be treated as first-class product assets.
- Use placeholders only where the real asset does not exist yet.
- Do not create generic stock illustrations as permanent substitutes for the intended artwork.
- Animations should support personality and feedback, not exist merely because animation is possible.
- Avoid excessive motion that makes the app annoying or slow.

## State and data

- Local state must be treated seriously even during UI prototyping.
- Do not make important screens depend directly on hardcoded UI state when a repository/local data abstraction is expected.
- Avoid fake implementations that would need to be completely rewritten when synchronization is introduced.
- Distinguish clearly between:
  - local persisted state
  - transient UI state
  - synchronized/delivered state
  - future server state
- Never silently introduce concepts such as read receipts when the product does not define them.
- Do not call something "read", "seen", or "unread" unless the product explicitly supports reliable read state.
- Preserve message immutability and history rules.

## Error handling

- Handle realistic failure cases deliberately.
- Do not silently swallow errors.
- Do not expose raw stack traces or implementation details to users.
- User-facing errors should be short, understandable, and appropriate to Rucola's tone.
- Network failures should not unnecessarily prevent access to locally stored data.
- Offline operation is a normal operating condition, not an exceptional edge case.
- Never make destructive assumptions when synchronization fails.

## Testing

- Test behaviour, not implementation details.
- Prioritize tests around domain rules and important state transitions.
- Add regression tests when fixing a bug.
- UI tests should cover important user journeys rather than every individual composable.
- Do not weaken or delete tests simply to make CI pass.
- If a test exposes a genuine design/architecture problem, fix the underlying problem rather than gaming the test.

## Verification

Before considering a task complete:

1. Build the project.
2. Run relevant tests.
3. Check for compilation warnings/errors that matter.
4. Inspect the changed code for accidental scope creep.
5. Verify the implemented behaviour against the product requirements.
6. If UI was changed, actually inspect/run the relevant screen when possible.
7. Report what was verified and anything that could not be verified.

Never claim that something was tested if it was not actually tested.

## Dependencies

- Keep dependency count low.
- Pin/lock versions through the normal project mechanisms.
- Do not add a dependency solely to avoid writing a small amount of straightforward code.
- Before adding a dependency, consider maintenance, Android compatibility, licensing, and whether it will still make sense when offline-first synchronization is introduced.

## Git behaviour

- Never commit directly to `main`.
- Work on a focused branch.
- Keep commits logically grouped and reasonably small.
- Do not mix unrelated changes into the same commit.
- Write commit messages that describe the actual change.
- Open a PR when the task is complete.
- The PR description should explain:
  - what changed
  - important technical decisions
  - how it was tested
  - anything intentionally deferred
- Do not rewrite history or force-push unless explicitly required.

## PR behaviour

- Treat the PR as something another engineer should be able to review quickly.
- Keep the diff focused.
- Do not hide architectural changes inside unrelated formatting changes.
- Call out assumptions and trade-offs.
- If you discover a problem outside the task, mention it rather than silently expanding scope.
- Fix obvious issues introduced by your own work before opening the PR.
- Leave the repository in a buildable state whenever practical.

## When blocked

If blocked by missing information:

1. First inspect the repository, existing docs, tests, and configuration.
2. Look for an existing convention or analogous implementation.
3. Infer the least surprising solution if the decision is reversible.
4. Ask the user only if the decision materially affects product behaviour or architecture.

Do not stop because of minor uncertainty.

## Security and privacy

- Treat Rucola as a private relationship application.
- Never log message contents, media contents, pairing secrets, authentication credentials, or other sensitive data unnecessarily.
- Never commit secrets, tokens, signing keys, credentials, or local configuration.
- Do not invent cryptography.
- When encryption/security becomes part of the implementation, use established protocols and libraries.
- Do not weaken security merely to make development easier.

## Performance

- Do not prematurely optimize.
- Do avoid obviously expensive patterns, especially on the main/UI thread.
- Assume some users will have slow devices, poor connections, or no connection at all.
- Local history should remain usable without network access.
- Media handling should avoid unnecessary copies and memory usage.
- Background work should be appropriate for the Android lifecycle.

## Agent self-review

Before submitting work, ask:

- Did I actually follow the product spec?
- Did I accidentally add something that was explicitly out of scope?
- Did I introduce unnecessary complexity?
- Would the original developer understand this code six months from now?
- Does this still feel like Rucola rather than a generic Android app?
- Is the architecture compatible with the documented offline-first model?
- Did I test the important behaviour?
- Is there anything I am claiming works that I did not actually verify?