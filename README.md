# openspice-mcp

An MCP server for SPICE circuit work. It reads SPICE netlists (`.cir`, `.net`, `.sp`) and LTspice schematics (`.asc`, `.asy`), generates LTspice schematics from a circuit description, and runs simulations with LTspice or ngspice, returning measurements and waveform summaries from the `.raw` results.

> Status: specification phase. See [`.kiro/specs/openspice-mcp/`](.kiro/specs/openspice-mcp/) for requirements, design, and tasks. No release yet.

## Planned usage

```json
{
  "mcpServers": {
    "openspice": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/openspice-mcp@latest"]
    }
  }
}
```

## License

MIT
