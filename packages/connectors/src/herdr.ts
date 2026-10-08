import {
  ConnectorRuntime,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type RuntimeConnectorDefinition,
} from '@lobu/connector-sdk';

const target = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-zA-Z0-9][a-zA-Z0-9:_-]*$',
  description:
    'Explicit agent name or pane id returned by Herdr. Never targets the focused pane implicitly.',
};
const pane = { ...target, description: 'Explicit pane id returned by Herdr.' };
const workspace = { ...target, description: 'Explicit workspace id returned by Herdr.' };
const timeout = { type: 'integer', minimum: 100, maximum: 120000, default: 30000 };
const until = {
  type: 'array',
  maxItems: 5,
  items: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'unknown'] },
};
const read = {
  source: {
    type: 'string',
    enum: ['visible', 'recent', 'recent-unwrapped', 'detection'],
    default: 'visible',
  },
  lines: { type: 'integer', minimum: 1, maximum: 500, default: 80 },
};
function action(
  key: string,
  name: string,
  description: string,
  kind: 'read' | 'write',
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ActionDefinition {
  return {
    key,
    name,
    description,
    kind,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: {
      destructiveHint: kind === 'write',
      openWorldHint: kind === 'write',
      idempotentHint: kind === 'read',
    },
  };
}

/** Shell only transports argv; all Herdr protocol and command semantics stay here. */
function quote(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0'))
    throw new Error('Expected a string without NUL bytes');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new Error(`${key} is required`);
  return value;
}
function id(input: Record<string, unknown>, key = 'target'): string {
  const value = text(input, key);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value))
    throw new Error(`${key} must be an explicit Herdr identifier`);
  return value;
}
function integer(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid numeric limit');
  return value;
}
function waitOptions(input: Record<string, unknown>): string[] {
  const states = input.until ?? [];
  if (
    !Array.isArray(states) ||
    states.length > 5 ||
    states.some((s) => !['idle', 'working', 'blocked', 'done', 'unknown'].includes(s))
  )
    throw new Error('Invalid wait states');
  return [
    '--timeout',
    String(integer(input.timeout_ms, 30000, 120000)),
    ...states.flatMap((s) => ['--until', s]),
  ];
}
function readOptions(input: Record<string, unknown>): string[] {
  const source = input.source ?? 'visible';
  if (!['visible', 'recent', 'recent-unwrapped', 'detection'].includes(String(source)))
    throw new Error('Invalid snapshot source');
  return [
    '--source',
    String(source),
    '--lines',
    String(integer(input.lines, 80, 500)),
    '--format',
    'text',
  ];
}
function commandFor(
  key: string,
  input: Record<string, unknown>,
): { argv: string[]; json: boolean; budget: number } {
  let argv: string[];
  let budget = 15000;
  let json = true;
  switch (key) {
    case 'snapshot':
      argv = ['api', 'snapshot'];
      break;
    case 'process_info':
      argv = ['pane', 'process-info', '--pane', id(input, 'pane_id')];
      break;
    case 'pane_read':
      argv = ['pane', 'read', id(input, 'pane_id'), ...readOptions(input)];
      json = false;
      break;
    case 'workspace_create': {
      const cwd = text(input, 'cwd');
      if (!cwd.startsWith('/'))
        throw new Error('cwd must be an absolute path on the selected device');
      argv = ['workspace', 'create', '--cwd', cwd, '--label', text(input, 'label'), '--no-focus'];
      break;
    }
    case 'workspace_close':
      argv = ['workspace', 'close', id(input, 'workspace_id')];
      break;
    case 'agent_list':
      argv = ['agent', 'list'];
      break;
    case 'agent_get':
      argv = ['agent', 'get', id(input)];
      break;
    case 'agent_start': {
      const name = text(input, 'name');
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw new Error('Invalid agent name');
      const args = input.args ?? [];
      if (
        !Array.isArray(args) ||
        args.length > 16 ||
        args.some((a) => typeof a !== 'string' || a.length > 512)
      )
        throw new Error('Invalid agent arguments');
      budget = integer(input.timeout_ms, 30000, 120000, 3001) + 5000;
      argv = [
        'agent',
        'start',
        name,
        '--kind',
        id(input, 'kind'),
        '--pane',
        id(input, 'pane_id'),
        '--timeout',
        String(budget - 5000),
        '--',
        ...args,
      ];
      break;
    }
    case 'agent_prompt': {
      if (input.wait !== true && (input.timeout_ms !== undefined || input.until !== undefined))
        throw new Error('timeout_ms and until require wait: true');
      // Herdr takes positionals literally and accepts --timeout/--until only with --wait.
      const wait = input.wait === true;
      if (wait) budget = integer(input.timeout_ms, 30000, 120000) + 5000;
      argv = [
        'agent',
        'prompt',
        id(input),
        text(input, 'text'),
        ...(wait ? ['--wait', ...waitOptions(input)] : []),
      ];
      break;
    }
    case 'agent_wait':
      budget = integer(input.timeout_ms, 30000, 120000) + 5000;
      argv = ['agent', 'wait', id(input), ...waitOptions(input)];
      break;
    case 'agent_read':
      argv = ['agent', 'read', id(input), ...readOptions(input)];
      json = false;
      break;
    case 'agent_interrupt':
      argv = ['agent', 'send-keys', id(input), 'ctrl+c'];
      break;
    default:
      throw new Error(`Unknown Herdr operation: ${key}`);
  }
  return { argv, json, budget };
}

export default class HerdrConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'herdr',
    name: 'Herdr',
    version: '1.0.0',
    faviconDomain: 'herdr.dev',
    description:
      'Inspect terminal workspaces and create, prompt, monitor or interrupt agents through an existing Shell connection. Requires Herdr 0.9+ installed and running on that device. Select shell_connection_id in connection settings; leave this connector on the server.',
    authSchema: { methods: [{ type: 'none' }] },
    feeds: {},
    optionsSchema: {
      type: 'object',
      required: ['shell_connection_id'],
      properties: {
        shell_connection_id: {
          type: 'integer',
          minimum: 1,
          title: 'Shell connection ID',
          description:
            'Discover the existing os.shell connection with operations.listAvailable. Its device and policies govern all commands.',
        },
        binary: {
          type: 'string',
          minLength: 1,
          title: 'Herdr executable',
          default: 'herdr',
          description: 'Executable name or absolute path on the selected device.',
        },
      },
      additionalProperties: false,
    },
    actions: {
      snapshot: action(
        'snapshot',
        'Workspace snapshot',
        'Structured workspaces, panes and agents from the running Herdr instance.',
        'read',
      ),
      process_info: action(
        'process_info',
        'Pane process',
        'Inspect the foreground process in an explicit pane.',
        'read',
        { pane_id: pane },
        ['pane_id'],
      ),
      pane_read: action(
        'pane_read',
        'Read pane',
        'Read bounded terminal output. Visible is passive; recent history may temporarily scroll idle terminals.',
        'read',
        { pane_id: pane, ...read },
        ['pane_id'],
      ),
      workspace_create: action(
        'workspace_create',
        'Create workspace',
        'Create an unfocused workspace and return its root pane. Start an agent in that pane with agent_start.',
        'write',
        {
          cwd: { type: 'string', pattern: '^/' },
          label: { type: 'string', minLength: 1, maxLength: 100 },
        },
        ['cwd', 'label'],
      ),
      workspace_close: action(
        'workspace_close',
        'Close workspace',
        'Close the specified workspace and its running processes. Use only for a workspace you intend to tear down.',
        'write',
        { workspace_id: workspace },
        ['workspace_id'],
      ),
      agent_list: action(
        'agent_list',
        'List agents',
        'List registered agents and their state.',
        'read',
      ),
      agent_get: action(
        'agent_get',
        'Agent status',
        'Inspect one agent by its returned name or pane id.',
        'read',
        { target },
        ['target'],
      ),
      agent_start: action(
        'agent_start',
        'Start agent',
        'Start an installed interactive agent in an existing idle shell pane. Returns when that agent is detected and ready.',
        'write',
        {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
          kind: { ...target, description: 'Installed Herdr agent kind to start.' },
          pane_id: pane,
          timeout_ms: { ...timeout, minimum: 3001 },
          args: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } },
        },
        ['name', 'kind', 'pane_id'],
      ),
      agent_prompt: action(
        'agent_prompt',
        'Prompt agent',
        'Submit a prompt or follow-up. timeout_ms and until require wait: true. Start from idle for reliable wait semantics: Herdr tracks terminal states, not turns. After timeout/stall, inspect before retrying; input may already have been delivered.',
        'write',
        {
          target,
          text: { type: 'string', minLength: 1, maxLength: 10000 },
          wait: { type: 'boolean', default: false },
          timeout_ms: timeout,
          until,
        },
        ['target', 'text'],
      ),
      agent_wait: action(
        'agent_wait',
        'Wait for agent',
        'Bounded state wait; already matching states return immediately. Cancelling this wait does not interrupt the persistent agent.',
        'read',
        { target, timeout_ms: timeout, until },
        ['target'],
      ),
      agent_read: action(
        'agent_read',
        'Read agent',
        'Read bounded terminal output to verify the actual result of a turn.',
        'read',
        { target, ...read },
        ['target'],
      ),
      agent_interrupt: action(
        'agent_interrupt',
        'Interrupt agent',
        'Send Ctrl+C to the explicitly selected agent. Inspect its state afterward.',
        'write',
        { target },
        ['target'],
      ),
    },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (!ctx.operations)
      return {
        success: false,
        error:
          'This Lobu host does not support connector operation delegation. Update the Lobu server.',
      };
    const connectionId = ctx.config.shell_connection_id;
    if (typeof connectionId !== 'number' || !Number.isSafeInteger(connectionId) || connectionId < 1)
      return {
        success: false,
        error: 'Configure shell_connection_id with an existing os.shell connection.',
      };
    const command = commandFor(ctx.actionKey, ctx.input);
    const binary = ctx.config.binary ?? 'herdr';
    const receipt = await ctx.operations.execute({
      connection_id: connectionId,
      operation_key: 'run',
      idempotency_key: 'herdr-command',
      input: {
        command: [binary, ...command.argv].map(quote).join(' '),
        timeout_ms: command.budget,
      },
    });
    if ('error' in receipt) return { success: false, error: receipt.error };
    if (receipt.status === 'pending_approval' || receipt.status === 'in_progress')
      return { success: true, output: { ...receipt } };
    if (receipt.status !== 'completed') return { success: false, error: JSON.stringify(receipt) };
    const shell = receipt.output as {
      exit_code?: number;
      timed_out?: boolean;
      stdout?: string;
      stderr?: string;
    };
    let result: unknown = shell?.stdout ?? '';
    if (command.json && typeof result === 'string' && shell?.exit_code === 0 && !shell?.timed_out) {
      try {
        result = JSON.parse(result);
      } catch {
        return {
          success: false,
          error: `Herdr returned invalid JSON (shell run ${receipt.run_id}); inspect that run before retrying.`,
        };
      }
    }
    if (
      !shell ||
      shell.exit_code !== 0 ||
      shell.timed_out ||
      (typeof result === 'object' && result !== null && 'error' in result)
    ) {
      return {
        success: false,
        error: JSON.stringify({
          run_id: receipt.run_id,
          exit_code: shell?.exit_code,
          timed_out: shell?.timed_out,
          result,
          stderr: shell?.stderr?.slice(-2000),
          message:
            'Inspect this run before retrying. A command or prompt may already have been delivered.',
        }),
      };
    }
    return { success: true, output: { status: 'completed', run_id: receipt.run_id, result } };
  }
}
