import { useMemo, useState } from "react";
import { api } from "../../core/api";
import { useSessionStore } from "../../core/stores/session";
import { buildOrgView } from "./orgGraph";
import styles from "./SettingsScreen.module.css";

/**
 * The org graph is what the AI routes on, so it has to be inspectable: who
 * exists, who reports to whom, which AI belongs to whom, who can approve what.
 * Adding a member here is the same call the iOS app makes — the relay
 * broadcasts `org_updated` and every client's routing changes at once.
 */
export function OrgSection() {
  const organization = useSessionStore((state) => state.organization);
  const setOrganization = useSessionStore((state) => state.setOrganization);

  const view = useMemo(() => buildOrgView(organization), [organization]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [team, setTeam] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addMember = async () => {
    if (!name.trim() || !role.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.addMember({
        name: name.trim(),
        role: role.trim(),
        team: team.trim() || undefined,
      });
      setOrganization(result.organization.users, {
        nodes: result.organization.nodes,
        edges: result.organization.edges,
      });
      setName("");
      setRole("");
      setTeam("");
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the member.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.group}>
      <h2 className={styles.groupTitle}>Organization</h2>
      <p className={styles.note}>
        {view.counts.people} people · {view.counts.teams} teams · {view.counts.agents} AI agents.
        This is the graph your AI routes on.
      </p>

      {view.teams.length === 0 && view.unassigned.length === 0 && (
        <p className={styles.note}>No org graph yet — add the first member below.</p>
      )}

      {view.teams.map((teamView) => (
        <div key={teamView.id} className={styles.team}>
          <div className={styles.teamName}>{teamView.label}</div>
          {teamView.members.map((member) => (
            <div key={`${teamView.id}-${member.id}`} className={styles.member}>
              <span className={styles.memberName}>{member.label}</span>
              <span className={styles.memberMeta}>
                {member.agentLabel && <span className={styles.tag}>✦ {member.agentLabel}</span>}
                {member.managerLabel && (
                  <span className={styles.tag}>↑ {member.managerLabel}</span>
                )}
                {member.approves.map((project) => (
                  <span key={project} className={styles.tag}>
                    ✓ {project}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}

      {view.unassigned.length > 0 && (
        <div className={styles.team}>
          <div className={styles.teamName}>No team</div>
          {view.unassigned.map((member) => (
            <div key={member.id} className={styles.member}>
              <span className={styles.memberName}>{member.label}</span>
            </div>
          ))}
        </div>
      )}

      {open ? (
        <>
          <div className={styles.field}>
            <input
              autoFocus
              value={name}
              aria-label="Member name"
              placeholder="Name"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <input
              value={role}
              aria-label="Role"
              placeholder="Role — Engineer, Designer, PM…"
              onChange={(event) => setRole(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <input
              value={team}
              aria-label="Team"
              placeholder="Team (optional — created if new)"
              onChange={(event) => setTeam(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addMember()}
            />
            <button disabled={saving || !name.trim() || !role.trim()} onClick={addMember}>
              {saving ? "…" : "Add"}
            </button>
          </div>
          <p className={styles.note}>
            The role decides what your AI routes to them; a new team name creates the team.
          </p>
          <button className={styles.row} onClick={() => setOpen(false)}>
            <span className={styles.rowIcon}>✕</span>
            Cancel
          </button>
        </>
      ) : (
        <button className={styles.row} onClick={() => setOpen(true)}>
          <span className={styles.rowIcon}>＋</span>
          Add a member
        </button>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
