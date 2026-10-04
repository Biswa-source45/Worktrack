"""Permission keys. Each milestone adds the keys for its own features."""

WEB_ACCESS = "web.access"
EMPLOYEES_MANAGE = "employees.manage"
DEVICES_MANAGE = "devices.manage"
ROLES_MANAGE = "roles.manage"
TEAM_VIEW = "team.view"

ALL_PERMISSIONS = frozenset({WEB_ACCESS, EMPLOYEES_MANAGE, DEVICES_MANAGE, ROLES_MANAGE, TEAM_VIEW})

SUPER_ADMIN_ROLE = "Super Admin"
