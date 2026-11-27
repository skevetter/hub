def filtered($pattern):
  if type == "string" and test("\\A(?:" + $pattern + ")\\z") then . else null end;
def version:
  "(0|[1-9][0-9]*)" as $part |
  filtered([$part, $part, $part] | join("\\.") + "|0\\.11\\.0-notifications\\." + $part);
def number: if type == "number" then . else null end;
def boolean: if type == "boolean" then . else null end;
def reason: filtered("refused|paused|not-newer|no-space|install-running|no-previous|no-tarball");
def failure_code: filtered("size|download|checksum|npm|restart|interrupted");
def valid:
  if $exit == 2 then .ok == false and (.reason|reason) != null
  elif $verb == "wait" then
    if $exit == 0 then .ok and .state == "done"
    elif $exit == 3 then .ok == false and .state == "failed" and (.code|failure_code) != null
    elif $exit == 5 then .ok == false and .state == "running"
    else $exit == 4 and .ok == false end
  elif $exit == 0 then .ok
  else ($exit == 3 or $exit == 4) and .ok == false end;
def checks: {
  service_active: (.service_active|boolean),
  version_matches: (.version_matches|boolean),
  migrations_match: (.migrations_match|boolean),
  local_health: (.local_health|boolean),
  daemons_connected: (.daemons_connected|boolean),
  log_clean: (.log_clean|boolean),
  no_new_incomplete_runs: (.no_new_incomplete_runs|boolean)
};
def counts: {
  migrations_db: (.migrations_db|number), migrations_packaged: (.migrations_packaged|number),
  error_lines: (.error_lines|number), incomplete_before: (.incomplete_before|number),
  incomplete_now: (.incomplete_now|number), restarts: (.restarts|number),
  daemons_active: (.daemons_active|number), daemons_connected: (.daemons_connected|number)
};
select(valid) | {ok} + (
  if $exit == 2 then {reason: (.reason|reason)} else {} end
) + (
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
    code: (.code|failure_code)}
  elif $verb == "smoke" then {checks: ((.checks // {})|checks), counts: ((.counts // {})|counts)}
  elif $verb == "rollback" then {started: (.started|boolean), to: (.to|version)}
  else {} end
)
