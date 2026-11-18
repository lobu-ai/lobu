#!/usr/bin/env bash
# Exercise the actual inline Claude invocation without starting a model or MCP.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/lobu-review-mcp-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
cat > "$scratch/bin/claude" <<'STUB'
#!/usr/bin/env python3
import json, os, sys
with open(os.environ['REVIEW_ARGV_CAPTURE'], 'w') as handle:
    json.dump({'argv':sys.argv[1:], 'base':os.environ.get('BASE_BRANCH'),
               'head':os.environ.get('HEAD_SHA'), 'ci':os.environ.get('CI_CHECKS_FILE')},handle)
print('synthetic reviewer output')
STUB
chmod +x "$scratch/bin/claude"
# Extract just the real Claude command, keeping quoting/redirections intact.
# A changed runner structure fails closed instead of silently testing a copy.
python3 - "$repo_root/scripts/review.sh" "$scratch/invoke.sh" <<'PY'
from pathlib import Path
import re, sys
source=Path(sys.argv[1]).read_text()
match=re.search(r'    claude\)\n(      run_review_child env \\\n.*?)(?=      ;;\n    codex\))',source,re.S)
if not match:
    raise SystemExit('Could not locate one actual Claude invocation')
Path(sys.argv[2]).write_text(match.group(1))
PY
export REVIEW_ARGV_CAPTURE="$scratch/argv.json"
export PATH="$scratch/bin:$PATH"
BASE_BRANCH='origin/main'
HEAD_SHA='0123456789012345678901234567890123456789'
CI_CHECKS_FILE="$scratch/ci checks.json"
CLAUDE_REVIEW_MODEL='opus'
CLAUDE_REVIEW_EFFORT='high'
prompt_file="$scratch/prompt.txt"
SCHEMA_FILE="$scratch/schema.json"
raw_file="$scratch/result.txt"
printf '%s\n' 'Synthetic review prompt' > "$prompt_file"
printf '%s\n' '{"type":"object"}' > "$SCHEMA_FILE"
run_review_child() { "$@"; }
. "$scratch/invoke.sh"
python3 - "$REVIEW_ARGV_CAPTURE" <<'PY'
import json, sys
value=json.load(open(sys.argv[1]));args=value['argv']
assert args.count('--strict-mcp-config')==1, args
assert args.count('--mcp-config')==1, args
assert json.loads(args[args.index('--mcp-config')+1])=={'mcpServers':{}}, args
assert args[args.index('--model')+1]=='opus', args
assert args[args.index('--effort')+1]=='high', args
assert args[args.index('--tools')+1]=='Bash,Read,Grep,LS', args
assert args[args.index('--permission-mode')+1]=='bypassPermissions', args
assert args[args.index('--json-schema')+1]=='{"type":"object"}', args
assert '--no-session-persistence' in args, args
assert value['base']=='origin/main' and len(value['head'])==40, value
assert value['ci'].endswith('/ci checks.json'), value
print('inline Claude strict-empty-MCP invocation tests passed')
PY
