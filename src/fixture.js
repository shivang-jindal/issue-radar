// Fixture fetch: turns a recorded API fixture (test/fixtures/*.json) into a
// fake fetchFn so scans can run fully offline. Never touches the network.

export function fixtureResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

export function buildFixtureFetch(fixture) {
  const repos = fixture?.repos ?? {};
  return async function fixtureFetch(url) {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean);
    // /repos/{o}/{r}
    if (parts[0] === 'repos' && parts.length === 3) {
      const meta = repos[parts[1] + '/' + parts[2]]?.meta;
      return meta
        ? fixtureResponse(200, meta)
        : fixtureResponse(404, { message: 'Not Found' });
    }
    // /repos/{o}/{r}/issues  (API returns issues AND PRs; filter by labels=)
    if (parts[0] === 'repos' && parts.length === 4 && parts[3] === 'issues') {
      const entry = repos[parts[1] + '/' + parts[2]];
      if (!entry) return fixtureResponse(404, { message: 'Not Found' });
      const wanted = (u.searchParams.get('labels') ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const list = (entry.issues ?? []).filter(
        (issue) =>
          !wanted.length ||
          (issue.labels ?? []).some((l) =>
            wanted.includes(String(typeof l === 'string' ? l : l?.name).toLowerCase()),
          ),
      );
      return fixtureResponse(200, list);
    }
    // /repos/{o}/{r}/issues/{n}/timeline
    if (parts[0] === 'repos' && parts.length === 6 && parts[3] === 'issues' && parts[5] === 'timeline') {
      const entry = repos[parts[1] + '/' + parts[2]];
      const events = entry?.timelines?.[parts[4]];
      if (!entry) return fixtureResponse(404, { message: 'Not Found' });
      return fixtureResponse(200, events ?? []);
    }
    return fixtureResponse(404, { message: `fixture has no route for ${u.pathname}` });
  };
}
