#!/usr/bin/env bash
# Exact staged-source helpers shared by remote providers.

remote_ci_require_no_untracked() {
  local untracked
  untracked="$(git ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    echo "Remote CI cannot include untracked files." >&2
    echo "Stage each intended new file explicitly before rerunning:" >&2
    printf '%s\n' "$untracked" | sed 's/^/  git add -- /' >&2
    return 1
  fi
}

# Return the exact staged Git tree, failing closed on a dirty index or
# untracked files so a full remote gate runs against a settled tree.
remote_ci_staged_tree() {
  remote_ci_require_no_untracked || return 1
  if ! git diff --quiet --ignore-submodules=none --; then
    echo "Full remote CI requires all intended changes to be staged." >&2
    echo "Run git add -- <explicit-paths>, then rerun make pr-full." >&2
    return 1
  fi
  git write-tree
}

# Materialize the index and the submodule commit recorded in that index.
remote_ci_materialize() {
  local stage="$1" pin
  mkdir -p "$stage/packages/owletto"
  git checkout-index -a -f --prefix="$stage/"
  if [ -e packages/owletto/.git ]; then
    pin="$(git ls-files --stage -- packages/owletto | awk '$1 == "160000" { print $2 }')"
    [ -n "$pin" ] || { echo "Missing staged Owletto gitlink." >&2; return 1; }
    git -C packages/owletto archive "$pin" | tar -x -C "$stage/packages/owletto"
  else
    printf '%s\n' '{"name":"@lobu/owletto","private":true,"version":"1.6.0","description":"Stub — private submodule not initialized"}' > "$stage/packages/owletto/package.json"
  fi
}
