import type { OrganizationGraph, OrgNode } from "../../core/types";

// The relay's org graph is a flat node/edge list because that's what routing
// needs. People read hierarchies, so this folds it into teams → members, with
// each member's AI, manager and approval rights attached.

export interface OrgMember {
  id: string;
  label: string;
  agentLabel: string | null;
  managerLabel: string | null;
  approves: string[];
}

export interface OrgTeam {
  id: string;
  label: string;
  members: OrgMember[];
}

export interface OrgView {
  teams: OrgTeam[];
  /** People in the graph who belong to no team — still routable, so still shown. */
  unassigned: OrgMember[];
  counts: { people: number; teams: number; agents: number };
}

const labelOf = (nodes: Map<string, OrgNode>, id: string) => nodes.get(id)?.label ?? id;

export function buildOrgView(graph: OrganizationGraph): OrgView {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const people = graph.nodes.filter((node) => node.kind === "person");
  const teams = graph.nodes.filter((node) => node.kind === "team");

  const agentOf = new Map<string, string>();
  const managerOf = new Map<string, string>();
  const approvesOf = new Map<string, string[]>();
  const teamsOf = new Map<string, string[]>();

  for (const edge of graph.edges) {
    switch (edge.kind) {
      case "assignedTo": // agent → person
        agentOf.set(edge.toID, labelOf(nodes, edge.fromID));
        break;
      case "manages": // manager → report
        managerOf.set(edge.toID, labelOf(nodes, edge.fromID));
        break;
      case "canApprove": // person → project
        approvesOf.set(edge.fromID, [
          ...(approvesOf.get(edge.fromID) ?? []),
          labelOf(nodes, edge.toID),
        ]);
        break;
      case "memberOf": // person → team
        teamsOf.set(edge.fromID, [...(teamsOf.get(edge.fromID) ?? []), edge.toID]);
        break;
      default:
        break;
    }
  }

  const memberFor = (person: OrgNode): OrgMember => ({
    id: person.id,
    label: person.label,
    agentLabel: agentOf.get(person.id) ?? null,
    managerLabel: managerOf.get(person.id) ?? null,
    approves: approvesOf.get(person.id) ?? [],
  });

  const built = teams
    .map((team) => ({
      id: team.id,
      label: team.label,
      members: people.filter((person) => teamsOf.get(person.id)?.includes(team.id)).map(memberFor),
    }))
    // An empty team is graph noise, not org structure.
    .filter((team) => team.members.length > 0);

  return {
    teams: built,
    unassigned: people.filter((person) => !teamsOf.has(person.id)).map(memberFor),
    counts: {
      people: people.length,
      teams: built.length,
      agents: graph.nodes.filter((node) => node.kind === "agent").length,
    },
  };
}
