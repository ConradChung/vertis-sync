# Lume agent: projects (design)

Approved by the owner on 2026-10-28: "folder + knowledge", files and chats both drag-and-drop, optional vertical link.

## What a project is

A project is a named folder of agent conversations. It also holds **knowledge** that the agent sees in every chat inside it:

- **Instructions:** free text, for example "Roofers in Austin; never order more than 2k; tone: casual".
- **Files:** CSV, PDF, MD, TXT, JSON and images, dropped onto the project.
- **Notes:** short text snippets.
- **Optional vertical:** a link to one `lume_verticals` row.

## Data

- **`agent_projects`**
  - columns: `id`, `name` (unique among live projects), `instructions` (text), `vertical_id` (null, fk), `position` (int), `created_at`, `archived_at`
  - RLS and grants follow the `agent_conversations` pattern
- **`agent_project_files`**
  - columns: `id`, `project_id`, `kind` (`file` | `note`), `name`, `mime`, `size_bytes`, `storage_path` (null for notes), `text_content` (extracted text, capped), `created_at`
  - files are stored in a private Storage bucket `agent-projects`
- **`agent_conversations.project_id`**: nullable fk, `on delete set null`
  - null means "Unfiled"

## Agent context

When a run is in a conversation that has a project, the system prompt gets a cached "Project" block:

- the name
- the instructions
- an index of the files and notes, each with name, kind and size
- the full text inline for small items, up to a total budget of about 20k characters, newest first

A read tool, `read_project_file(id, offset?)`, returns the extracted text for anything beyond that budget. Images are passed as image blocks only when the owner attaches them to a message; in the project they are listed by name.

Text extraction happens at upload:

| Type | Extraction |
|---|---|
| CSV | header plus the first 200 rows |
| PDF | text layer |
| MD, TXT, JSON | as-is |

Each file is capped at 200k characters stored. If a file can't be extracted, it is still stored and shown as "not readable".

## Vertical link

Linking a project to a vertical has two effects:

- A new chat started by that vertical's bot, or started from `/operator` "Message Lume's agent", is filed into the project automatically.
- Those chats inherit the project's knowledge.

Each vertical can be linked to at most one live project.

## UI (Agent tab sidebar, AgentHistory)

**Sidebar**

- Collapsible project groups, plus an "Unfiled" group.
- A "New project" button.
- Drag a chat onto a project to file it; drag it onto "Unfiled" to remove it from the project.
- Drag projects to reorder them.
- Use native HTML5 drag-and-drop or a small library such as dnd-kit.
- Keyboard and touch fallback: a "Move to project" item in each chat's menu, which also covers mobile.

**Project page or panel** (`/agent/projects/<id>`, or a side sheet)

- Instructions editor.
- A drop zone for files: drag files onto it, or onto the project row in the sidebar.
- A list of files and notes with delete.
- The linked vertical picker.
- The project's chats.
- "New chat in project".

**Chat header** shows a project chip and offers "Move to project".

## Errors and limits

- Upload limit is 20 MB per file, with a per-project total of 200 MB.
- Unsupported types are rejected with a message.
- Deleting a project moves its chats to Unfiled; there is no cascade delete of chats.

## Testing

- **Unit tests:**
  - prompt block budget and truncation
  - extraction per type
  - routing of vertical chats into their project
  - move and reorder APIs
- **Component tests:** drag-and-drop file and move actions, including the menu fallback.
- **pgTAP:** tables, RLS, and fk `set null`.
