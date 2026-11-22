# Roadmap

The work order and the only tracker of future work. Check an item only with
linked evidence.

## Phase 1: first build

- [x] Create the repository with the owner's standard settings and tooling.
- [ ] Add the default-branch ruleset matching the sibling repositories.
- [ ] Implement the request path, the Durable Object and the MCP tools in
      [the design](design.md), with tests.
- [ ] Issue a deploy token through risu729/infra and add the deploy job.
- [ ] Attach both Custom Domains and check that no Access app covers
      `tayori.takuk.me`.
- [ ] Register `tayori-mcp.takuk.me` in the owner Portal (two infra PRs and a
      one-time dashboard authentication).
- [ ] The owner sets `TARGET_GROK_A` and `TARGET_GROK_B`; the bots' rules add
      the `set_active` call.
- [ ] Point fumi's routing destination at `https://tayori.takuk.me/in/fumi`
      and run an end-to-end check with a real test mail.
