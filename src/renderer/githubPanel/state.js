function createEmptyChangesData() {
  return {
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    totalCount: 0,
    unpushedCommits: [],
    outgoingCommits: [],
    incomingCommits: [],
    localCommits: [],
    commitGraphByHash: {},
    activity: [],
    activityTotal: 0,
    hasUpstream: false,
    trackingBranch: null
  };
}

module.exports = { createEmptyChangesData };
