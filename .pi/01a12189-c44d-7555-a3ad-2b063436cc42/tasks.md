# TODO: Sync community fork improvements

- [x] 1. Merge `upstream/master` (pi 1.1.0 + 5 fixes; resolve CHANGELOG/pkg.json/lock)
- [x] 2. Cherry-pick `87f05ab` — inherit parent thinking level
- [x] 3. Cherry-pick `20d09cc` — `subagents:usage` / `subagents:disposed` events
- [/] 4. Cherry-pick `09cc7b3` — built-in codemode/tool-search/MCP extensions in subagents
- [ ] 5. Manual apply `265fe99` — boot from `dist/index.js` + `prepare` script
- [ ] 6. Manual port `05381dc` — stream in-flight thinking/assistant text in viewer
- [ ] 7. Manual port `2dc1be9` — live tool output in viewer
- [ ] 8. Full check: lint + typecheck + tests
