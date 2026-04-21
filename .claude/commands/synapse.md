# Send Session to Synapse

You are about to summarize this Claude Code session and send it to the user's Synapse knowledge graph via the `send_to_synapse` MCP tool.

## Instructions

1. **Check for user guidance.** If the user provided text after `/synapse` (e.g. `/synapse focus on the competitive analysis`), treat that as guidance. Emphasize those areas in the summary and pass the guidance string to the MCP tool's `guidance` parameter. If no guidance was provided, summarize the entire session with equal weight across all topics.

2. **Auto-detect context:**
   - **Title:** Generate a concise, descriptive title (under 80 chars) that captures what this session was about. Think of it like a commit message for the conversation.
   - **Repo:** Detect from the current working directory (the git repo name). Run `basename $(git rev-parse --show-toplevel)` if needed.
   - **Branch:** Detect from the current git branch. Run `git branch --show-current` if needed.

3. **Generate the structured markdown summary** using the template below. Review the FULL conversation from the beginning. Do not just summarize the last few messages.

4. **Template rules:**
   - Omit any section that has no relevant content. Do not include empty headers.
   - Each bullet should be self-contained and meaningful for knowledge extraction.
   - Include file paths, function names, and technical specifics where relevant.
   - Reference people, organizations, projects, and concepts by name.
   - The Summary section should read as a standalone briefing of the session.

5. **Call the `send_to_synapse` MCP tool** with:
   - `title`: the auto-generated title
   - `content`: the full markdown summary
   - `repo`: the detected repo name
   - `branch`: the detected branch name
   - `guidance`: the user's custom guidance (if provided), otherwise omit this parameter

6. **Confirm to the user** with the title, source ID, and entity/relationship counts from the response.

## Markdown Template

Use this structure. Omit sections with no content.

```markdown
# Session: [title]
**Date:** [YYYY-MM-DD]
**Repo:** [repo name]
**Branch:** [branch name]

## Summary
[2-3 sentence overview of what this session covered and accomplished]

## Key Insights
- [Insight with enough context to be useful standalone]

## Topics Covered
- [Topic and what was discussed and why it matters]

## Decisions Made
- [Decision and the reasoning behind it]

## Technical Advancements
- [What was built, fixed, or changed with file paths where relevant]

## Skills & Methodologies Referenced
- [Frameworks, patterns, or approaches that were applied]

## Updates & Status Changes
- [What moved forward, what is complete, what is blocked]

## Action Items
- [Outstanding follow-ups or next steps]

## User Guidance Notes
[Only if guidance was provided. What the user asked to emphasize and what was found.]
```
