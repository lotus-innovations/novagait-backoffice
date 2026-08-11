// Same-origin guard for state-changing POSTs (milestone review: Basic auth
// and cookies replay on cross-site form posts, so /admin and the decision
// endpoints were CSRF-open). Browsers send Sec-Fetch-Site on all fetches
// and Origin on cross-origin form POSTs; curl/cron send neither, which
// passes - the guard targets browsers, auth still gates the rest.

export function sameOriginViolation(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return true;
  }
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return true;
    } catch {
      return true;
    }
  }
  return false;
}
