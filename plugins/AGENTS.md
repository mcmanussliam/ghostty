# Plugin development

- Author runtime code in TypeScript. Generated JavaScript belongs in ignored `dist/` directories.
- Run `npm ci --ignore-scripts`, then `npm test`, `npm run check`, and `npm run lint`.
- Use Ghostty's default Prettier formatting. Do not disable type or lint checks to make a change pass.
- Keep Node and browser compiler settings separate. Use explicit ESM extensions for Node imports.
- Treat external JSON and IPC as `unknown`; validate values before using them. Types do not replace runtime checks.
- Prefer named operations, early returns, and exhaustive message routing to long conditional chains.
- Keep state ownership and cleanup explicit. Await promises, return them, or handle failures for background work.
- Avoid `any`, non-null assertions, nested ternaries, and unnecessary copies of collections.
- Keep runtime dependencies at zero. Add development tooling only when it enforces a useful rule.
- JavaScript test fixtures exercise compatibility with user-authored JS plugins. Test the compiled runtime.
- `macos/build.nu` compiles plugins before Xcode packages `plugins/dist/host`. Install development dependencies first.

References: [TypeScript's Node module guidance](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html),
[typescript-eslint's typed linting](https://typescript-eslint.io/getting-started/typed-linting/),
and [Ghostty's contributor rules](../CONTRIBUTING.md).
