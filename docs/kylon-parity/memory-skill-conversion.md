# Memory to skill: implementation contract

Status: design, not implemented. This does not close KY-031.

## Required behavior

Convert the selected, versioned memory into a custom skill containing the complete title, description and body. Install it on the source agent. Offer keeping the source memory; otherwise remove it only after the skill and installation are committed. Errors must retain the source. The actor is a human workspace member who can edit the source agent and currently access the source conversation.

The UI must show the source, destination agent, inherited conversation restriction and whether the memory will be removed. Preserve entered choices on failure. A request uses the displayed expectedVersion, not a newly fetched version that would silently override concurrent edits.

## Existing foundations and gaps

- `memoryEntries.js` stores title120, description500, body16000 and a version. Legacy memory version is0.
- `skills.js` now accepts the same field lengths and rejects excessive input instead of truncating. Combined SKILL.md output including YAML metadata must fit64KiB. This is validated before persistence.
- `createSkill` defaults to workspace visibility; conversion must never use this default.
- Current private skills execute only in the owner's direct agent conversation. This alone cannot represent a source memory in a private room.
- `giveSkill` is a separate write. Calling createSkill, giveSkill and deleteAgentMemory in sequence does not provide atomic conversion.
- `mayUseConversation` resolves current membership and canonical channel keys. Membership at conversion time is not a permanent grant.

## Scope model

Add provenance and execution scope in a dedicated table keyed by org and skill, with source memory ID/version, source agent, canonical source channel, conversion actor and timestamp. Retain provenance after source removal; do not use a cascading source-memory FK. Cascade when the skill is deleted. A scoped skill must not be silently promoted through the existing sharing endpoint or linked to another agent.

| Source | Read/export requirements | Execution requirements |
| --- | --- | --- |
| Agent memory | Current workspace membership plus current source-agent access | Source agent only, with current run authorization; retain the existing semantics of agent-wide memory |
| Conversation memory | Current workspace membership, source-agent access and source-conversation access | Exact source agent and canonical conversation, plus current run/conversation authorization |

For conversation memories, leaving the room or losing agent access must immediately revoke catalog visibility, direct read, exports, support-file access and model tools. The conversion owner does not bypass revoked source access. Workflows and follow-ups must supply their server-derived context; missing or different context cannot execute conversation-scoped instructions.

Do not reinterpret Kylon relevance metadata as an authorization rule. The scope record is a server-enforced Honmaru privacy boundary. Existing unscoped skills retain their current workspace/private behavior.

## Atomic write protocol

1. Resolve current actor, agent edit permission and conversation before loading the source.
2. Validate expectedVersion, source scope, complete fields, SKILL.md package limits and workspace skill capacity. No mutation on validation failure.
3. Use one D1 batch. Its first INSERT SELECT creates the skill only while the source still matches org, agent, canonical channel and expectedVersion and capacity remains available.
4. Policy, provenance, support files and installation inserts must depend on the exact new skill ID created by this operation. They cannot create orphans if the conditional source insert loses a race.
5. If source removal was requested, delete only when this exact conversion/provenance record and installation exist. Never delete on a preflight result alone.
6. Return success only when the required writes occurred; otherwise return a conflict and preserve source and existing skills. An injected failure in any later statement must roll back the whole batch.
7. A replay identifier must bind actor, source/version, scope and keep/remove choice. Repeating the same successful request returns the same skill; incompatible reuse conflicts. A lost HTTP response must not duplicate skills or delete a later source version.

The generated SKILL.md may use the title as a description fallback only when the source description is empty; preserve the empty original description in provenance if needed for a faithful reverse view. Do not fabricate instructions or silently shorten text.

## Verification gates

- Full-length Japanese fields and Markdown delimiters survive save/export/import.
- Empty-description legacy memories convert to importable packages without inventing body text.
- Stale version, wrong workspace, wrong agent and wrong conversation create nothing and remove nothing.
- Concurrent conversions and response retries do not produce duplicate installed skills.
- Injected installation/file/provenance failure rolls back source removal and all partial writes.
- Keep-source leaves the original version/body intact. Remove-source retains review audit according to the current retention model.
- Catalog/list/get/export/ZIP/support-file/read_installed_skill all apply current inherited scope.
- Room removal, agent privatization and membership revocation apply immediately, including to the conversion owner.
- An unauthorized agent, shared workflow, missing channel or alternate conversation cannot execute the converted skill.
- Existing unscoped skill and Simple behavior remain unchanged.
- UI verified in light/dark, narrow layout, retry/conflict states and keyboard navigation before production publication.
