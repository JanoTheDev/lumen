// Integrations catalog for Settings → Connectors: well-known MCP servers with their official
// address or command, checked against each vendor's own docs (dates and sources in
// plans/08-agents-connectors/tasks.md). Adding one still goes through connectors:add, so a
// local command needs the user's "I trust this command" tick and every tool call goes through
// the safety policy. Servers that only accept pre-approved apps (no dynamic client
// registration) are left out. Pure data, no imports.

export interface CatalogEntry {
  /** Suggested connector id (tools appear as mcp__<id>__<tool>). */
  id: string
  name: string
  /** What it does, one sentence. */
  description: string
  kind: 'remote' | 'local'
  /** remote: the Streamable HTTP endpoint. */
  url?: string
  /** local: program and fixed arguments. */
  command?: string
  args?: string[]
  /** local: the user picks folders, appended as arguments (after `flag` when set). */
  folders?: { label: string; flag?: string; single?: boolean }
  /** remote: OAuth sign-in in the browser (authorization code + PKCE, loopback redirect). */
  oauth?: boolean
  /** remote: an access token sent as Authorization: Bearer. */
  token?: { required: boolean; hint: string }
  /** What must be installed first. */
  needs?: string
  /** Official docs or repository. */
  source: string
  /** When the address and sign-in were last checked against `source` (YYYY-MM-DD). */
  checked: string
  category: 'Code' | 'Docs' | 'Work' | 'Business' | 'Files and web' | 'Design'
}

const CHECKED = '2026-10-01'
const NODE = 'Node.js (free, nodejs.org)'
const UV = 'Python with uv (free, docs.astral.sh/uv)'

export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  // ---- remote ----
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests and Actions on GitHub.',
    kind: 'remote',
    url: 'https://api.githubcopilot.com/mcp/',
    token: {
      required: true,
      hint: 'A GitHub personal access token (Settings → Developer settings). Its scopes decide what Lumen can reach.'
    },
    source: 'https://github.com/github/github-mcp-server',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and edit your Notion pages and databases.',
    kind: 'remote',
    url: 'https://mcp.notion.com/mcp',
    oauth: true,
    source: 'https://developers.notion.com/docs/get-started-with-mcp',
    checked: CHECKED,
    category: 'Work'
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Find, create and update Linear issues, projects and comments.',
    kind: 'remote',
    url: 'https://mcp.linear.app/mcp',
    oauth: true,
    token: { required: false, hint: 'Or a Linear API key instead of signing in.' },
    source: 'https://linear.app/docs/mcp',
    checked: CHECKED,
    category: 'Work'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Search errors, triage issues and look at performance in Sentry.',
    kind: 'remote',
    url: 'https://mcp.sentry.dev/mcp',
    oauth: true,
    source: 'https://mcp.sentry.dev',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage Supabase projects and run SQL.',
    kind: 'remote',
    url: 'https://mcp.supabase.com/mcp',
    oauth: true,
    token: { required: false, hint: 'Or a Supabase personal access token instead of signing in.' },
    source: 'https://supabase.com/docs/guides/getting-started/mcp',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Look up and change Stripe data, and search the Stripe docs.',
    kind: 'remote',
    url: 'https://mcp.stripe.com',
    oauth: true,
    token: { required: false, hint: 'Or a Stripe Agent API key instead of signing in.' },
    source: 'https://docs.stripe.com/mcp',
    checked: CHECKED,
    category: 'Business'
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'PayPal invoices, orders and other account tools.',
    kind: 'remote',
    url: 'https://mcp.paypal.com/http',
    oauth: true,
    source: 'https://developer.paypal.com/tools/mcp-server/',
    checked: CHECKED,
    category: 'Business'
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Search Intercom conversations and contacts (US workspaces).',
    kind: 'remote',
    url: 'https://mcp.intercom.com/mcp',
    oauth: true,
    token: { required: false, hint: 'Or an Intercom access token instead of signing in.' },
    source: 'https://developers.intercom.com/docs/guides/mcp',
    checked: CHECKED,
    category: 'Business'
  },
  {
    id: 'webflow',
    name: 'Webflow',
    description: 'Webflow sites, pages and CMS collections.',
    kind: 'remote',
    url: 'https://mcp.webflow.com/mcp',
    oauth: true,
    source: 'https://developers.webflow.com/mcp/reference/getting-started',
    checked: CHECKED,
    category: 'Design'
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Boards and items on monday.com.',
    kind: 'remote',
    url: 'https://mcp.monday.com/mcp',
    token: { required: true, hint: 'Your monday.com personal API token.' },
    source: 'https://developer.monday.com/api-reference/docs/mondaycom-mcp',
    checked: CHECKED,
    category: 'Work'
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Run the Zapier actions you set up, across thousands of apps.',
    kind: 'remote',
    url: 'https://mcp.zapier.com/api/v1/connect',
    token: { required: true, hint: 'The connection token you make at mcp.zapier.com.' },
    source: 'https://docs.zapier.com/mcp/overview/how-connections-work',
    checked: CHECKED,
    category: 'Work'
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Search models, datasets, Spaces and papers on Hugging Face.',
    kind: 'remote',
    url: 'https://huggingface.co/mcp',
    token: { required: false, hint: 'Optional Hugging Face token for more tools.' },
    source: 'https://huggingface.co/docs/hub/en/hf-mcp-server',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation and code examples for programming libraries.',
    kind: 'remote',
    url: 'https://mcp.context7.com/mcp',
    token: { required: false, hint: 'Optional Context7 API key for higher limits.' },
    source: 'https://github.com/upstash/context7',
    checked: CHECKED,
    category: 'Docs'
  },
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    description: 'Ask questions about public GitHub repositories.',
    kind: 'remote',
    url: 'https://mcp.deepwiki.com/mcp',
    source: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
    checked: CHECKED,
    category: 'Docs'
  },
  {
    id: 'ms-learn',
    name: 'Microsoft Learn',
    description: 'Search Microsoft documentation and code samples.',
    kind: 'remote',
    url: 'https://learn.microsoft.com/api/mcp',
    source: 'https://learn.microsoft.com/en-us/training/support/mcp',
    checked: CHECKED,
    category: 'Docs'
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare docs',
    description: 'Search the Cloudflare documentation.',
    kind: 'remote',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    source: 'https://github.com/cloudflare/mcp-server-cloudflare',
    checked: CHECKED,
    category: 'Docs'
  },
  {
    id: 'figma-desktop',
    name: 'Figma (desktop app)',
    description: 'Design context of the frame selected in the Figma desktop app.',
    kind: 'remote',
    url: 'http://127.0.0.1:3845/mcp',
    needs: 'The Figma desktop app with Dev Mode → "Enable desktop MCP server" turned on',
    source: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/',
    checked: CHECKED,
    category: 'Design'
  },
  // ---- local ----
  {
    id: 'files',
    name: 'Files (folders you choose)',
    description: 'Read and write files, only inside the folders you list.',
    kind: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    folders: { label: 'Folders it may use, one per line' },
    needs: NODE,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    checked: CHECKED,
    category: 'Files and web'
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Status, diff, log and commits of one Git repository.',
    kind: 'local',
    command: 'uvx',
    args: ['mcp-server-git'],
    folders: { label: 'Repository folder', flag: '--repository', single: true },
    needs: UV,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'memory-graph',
    name: 'Knowledge graph memory',
    description: 'A small local knowledge graph the agent can store and look up facts in.',
    kind: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    needs: NODE,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    checked: CHECKED,
    category: 'Files and web'
  },
  {
    id: 'thinking',
    name: 'Sequential thinking',
    description: 'A step-by-step reasoning tool for long problems.',
    kind: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    needs: NODE,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    checked: CHECKED,
    category: 'Code'
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a web page and read it as text.',
    kind: 'local',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    needs: UV,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    checked: CHECKED,
    category: 'Files and web'
  },
  {
    id: 'time',
    name: 'Time',
    description: 'The current time and time zone conversions.',
    kind: 'local',
    command: 'uvx',
    args: ['mcp-server-time'],
    needs: UV,
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    checked: CHECKED,
    category: 'Files and web'
  },
  {
    id: 'playwright',
    name: 'Playwright browser',
    description: 'Drive a separate browser window through its accessibility tree.',
    kind: 'local',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    needs: NODE,
    source: 'https://github.com/microsoft/playwright-mcp',
    checked: CHECKED,
    category: 'Files and web'
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: 'Control and inspect Google Chrome through DevTools.',
    kind: 'local',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    needs: `${NODE} and Google Chrome`,
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    checked: CHECKED,
    category: 'Code'
  }
]

/** The arguments for a local entry with the user's folders. */
export function catalogArgs(e: CatalogEntry, folders: readonly string[] = []): string[] {
  const base = [...(e.args ?? [])]
  if (!e.folders) return base
  const list = (e.folders.single ? folders.slice(0, 1) : folders).filter((f) => f.trim())
  for (const f of list) base.push(...(e.folders.flag ? [e.folders.flag, f.trim()] : [f.trim()]))
  return base
}
