# Changelog

All notable changes to Email-VPS are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- Rclone operations control route/page and subnav entry.
- Rclone control API support and trigger-sync action path.
- Extended ops diagnostics rendering and failure-state panels for operations pages.
- UNIX socket ops daemon protocol with HMAC signing, timestamp window enforcement, and nonce replay protection.
- Ops daemon server/runtime components for allowlisted systemd actions (AIDE-first rollout, expandable to other controls).
- `start:ops-daemon` script for dedicated daemon process startup.

### Changed
- Operations page hydration behavior and chart/visual rendering for control data.
- Dashboard operations JS/CSS for deeper control visualizations.
- Ops command runner now supports daemon-backed execution mode while preserving existing run/status/stream API paths.
- Runtime/env model expanded with daemon and control-unit mapping keys for phased migration.

### Fixed
- Loading-stuck behavior via explicit error panel fallback.
- Command execution backend parity improved by keeping legacy fallback and daemon mode behind flags.

### Solved
- Route/control parity updates for new operations sub-pages.
- Introduced a safer path to run privileged operations without exposing raw terminal access.

### Issues
- Deployment parity required on VPS for new routes after restart.

## [1.4.0] - 2026-02-19

### Added
- `/dashboard/operations` and dedicated control pages (AIDE/Fail2Ban/Relay/Postfix/Crontab).
- `ops_events` persistence model and timeline APIs.
- New operational mail templates (`cron-warning`, `logwatch-digest`, `postfix-warning`, `delivery-probe`, enhanced `health-check`).
- Security header builder and phased CSP/HSTS hardening.

### Changed
- Dashboard boot split (`dashboard-pages-core/runtime`) and operations-focused rendering.
- Runbook/README ops diagnostics and remediation workflows.

### Fixed
- Auth integration stability via service injection corrections.

### Solved
- Cron stale path noise from `/opt/stackpilot-monitor` migration to repo path.

### Issues
- Clean-profile Lighthouse still needed for extension-free baseline evidence capture.

## [1.3.1] - 2026-02-19

### Added
- Git ignore protection for `.env.bak-*`.

### Changed
- Integration test app wiring for `opsInsightService`.

### Fixed
- Failing admin auth integration assertion caused by fallback service path.

### Solved
- Tracked env backup file drift in repo.

### Issues
- None.

## [1.3.0] - 2026-02-18

### Added
- OTP-primary public auth flow and preauth layer.
- Dedicated deep pages: Activity, Security, Health, Performance, Stability, Programs, Mail.
- Program checker and mail checker services.
- Ops helper scripts for cron/health/sudoers.

### Changed
- Login UX to OTP-first with credential second-step readiness.
- Dashboard navigation to multi-page operations console model.

### Fixed
- IP allowlist confusion by introducing allowlist toggle behavior.

### Solved
- Public access blockers post-DNS/TLS with stabilized runtime patterns.

### Issues
- OTP deliverability depends on mailbox filtering and relay hygiene.

## [1.2.0] - 2026-02-17

### Added
- Unified Balanced NOC dashboard UI.
- Insights and timeseries APIs.
- Chart-based operations visibility and richer dashboard services.

### Changed
- Mail templates toward structured ops digest style.
- Dashboard data pipeline for trends and actionable insights.

### Fixed
- Legacy split admin direction reduced in favor of single-dashboard runtime.

### Solved
- Early architecture drift between old admin and unified dashboard direction.

### Issues
- None.

## [1.1.0] - 2026-02-17

### Added
- Section 15 secure dashboard/auth APIs baseline.
- Session auth, login protections, and secure middleware foundations.

### Changed
- Environment validation tightened for dashboard credentials/secrets.

### Fixed
- Startup guardrails for missing auth env variables.

### Solved
- Initial secure admin control-plane requirements.

### Issues
- None.

## [1.0.0] - 2026-02-17

### Added
- Initial Email-VPS project structure.
- Core mail API, queueing, retry, quota, template registry, transport plumbing.
- Base tests for env, queue recovery, quota, API auth/local-only policy.

### Changed
- Established localhost bind and token-protected local mail API model.

### Fixed
- Script/path validation for metrics generation baseline.

### Solved
- Foundational mail pipeline bootstrap.

### Issues
- None.
