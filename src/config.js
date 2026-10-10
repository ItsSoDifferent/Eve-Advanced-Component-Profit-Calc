// Public client id of the EVE application used for SSO login. A client id is not a secret (the flow uses PKCE, so there
// is no client secret). Register an application at https://developers.eveonline.com/ with the scope
// esi-skills.read_skills.v1 and a callback URL equal to the address you serve this page from (for example
// http://localhost:8765/ and your GitHub Pages URL), then paste its client id here. If this is left empty the app lets
// each visitor enter a client id in the Character panel instead.
export const CLIENT_ID = "";
