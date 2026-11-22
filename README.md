# tayori

A signed webhook relay on Cloudflare Workers: verify, deduplicate and forward to
the active target. The name comes from _tayori_ (便り, a letter or news).

**Status: scaffold.** The Worker answers 404 to every request. See
[the design](docs/design.md) and [the roadmap](docs/roadmap.md).

## Development

Tools and tasks are in [`mise.toml`](mise.toml).

```sh
mise run fix  # format and apply lint fixes
mise run ci   # the same checks as GitHub Actions
```
