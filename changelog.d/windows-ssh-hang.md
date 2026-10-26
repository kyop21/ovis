### Fixed
- Connecting a remote PC from Windows no longer hangs at "Checking the remote environment…": the
  server now runs Git for Windows' OpenSSH, because the one that ships with Windows never exits
  after a remote command prints something when the server starts it. `OVIS_SSH` picks another
  `ssh`. Git's `ssh` does not read Windows' `ssh-agent` service, so a key held only there is
  asked for in the setup dialog once, and the app key makes later reconnects unattended.
