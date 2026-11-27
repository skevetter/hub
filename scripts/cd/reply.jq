def filtered($pattern):
  if type == "string" and test("\\A(?:" + $pattern + ")\\z") then . else null end;
def version: filtered("^[0-9]+\\.[0-9]+\\.[0-9]+(-notifications\\.[0-9]+)?$");
def number: if type == "number" then . else null end;
def boolean: if type == "boolean" then . else null end;
def checks: {
  service_active: (.service_active|boolean),
  version_matches: (.version_matches|boolean),
  migrations_match: (.migrations_match|boolean),
  local_health: (.local_health|boolean),
  daemons_connected: (.daemons_connected|boolean),
  log_clean: (.log_clean|boolean),
  no_new_incomplete_runs: (.no_new_incomplete_runs|boolean)
};
{ok} + (
  if $verb == "status" and .ok then {
    version: (.version|version),
    commit: (if has("commit") and .commit == null then null
      else (.commit|filtered("^[0-9a-f]{40}$")) // error("invalid commit") end),
    previous_version: (.previous_version|version), paused: (.paused|boolean),
    service: (.service|filtered("^(active|inactive|failed|activating|deactivating)$")),
    migrations: (.migrations|number), incomplete_runs: (.incomplete_runs|number),
    running_turns: (.running_turns|number), free_gb: (.free_gb|number),
    install: (.install|filtered("^(idle|running|done|failed)$")),
    restore_test: (if .restore_test == null then null else {
      time: (.restore_test.time|filtered("^[0-9TZ:+.-]{10,32}$")),
      ok: (.restore_test.ok|boolean)
    } end)
  }
  elif $verb == "precheck" then {version: (.version|version), running_version: (.running_version|version)}
  elif $verb == "quiet" then {waited: (.waited|number), quiet: (.quiet|boolean)}
  elif $verb == "backup" then {entries: (.entries|number), bytes: (.bytes|number)}
  elif $verb == "install" then {started: (.started|boolean)}
  elif $verb == "wait" then {state: (.state|filtered("^(running|done|failed)$")),
    code: (.code|filtered("^(checksum|download|npm|restart|ok)$"))}
  elif $verb == "smoke" then {checks: ((.checks // {})|checks)}
  elif $verb == "rollback" then {started: (.started|boolean), to: (.to|version)}
  else {} end
)
