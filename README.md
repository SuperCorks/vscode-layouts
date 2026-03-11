# VS Code Layouts

Save the current editor layout with a name and restore it later from the Command Palette or a keyboard shortcut.

## What it restores

- Editor group structure from `vscode.getEditorLayout`
- Open text, diff, notebook, notebook diff, and custom editor tabs where VS Code can reopen them
- Active editor group and active tab, best effort
- Explorer, terminal panel, and Copilot Chat panel best effort when VS Code exposes enough state to infer they were visible

## What it does not restore

- Desktop window size or monitor position
- Exact sidebar, panel, terminal, or Copilot Chat geometry
- Exact preview or pinned state for every tab
- Exact open-state detection for every workbench view, because VS Code does not expose full workbench layout state on the stable extension API

## Commands

- `VS Code Layouts: Save Layout`
- `VS Code Layouts: Apply Layout`
- `VS Code Layouts: Delete Layout`
- `VS Code Layouts: List Layouts`

## Keyboard shortcut example

Bind a shortcut directly to a named layout in `keybindings.json`:

```json
[
  {
    "key": "cmd+alt+1",
    "command": "vscodeLayouts.applyLayout",
    "args": {
      "name": "Debug"
    }
  }
]
```

If `args.name` is omitted, the command opens a picker of saved layouts.
