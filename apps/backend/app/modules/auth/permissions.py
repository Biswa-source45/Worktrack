"""Permission keys. Each milestone adds the keys for its own features."""

WEB_ACCESS = "web.access"
EMPLOYEES_MANAGE = "employees.manage"
DEVICES_MANAGE = "devices.manage"
ROLES_MANAGE = "roles.manage"
TEAM_VIEW = "team.view"
BRANCHES_MANAGE = "branches.manage"
SETTINGS_VIEW = "settings.view"
SETTINGS_MANAGE = "settings.manage"
FACE_REVIEW = "face.review"

ALL_PERMISSIONS = frozenset(
    {
        WEB_ACCESS,
        EMPLOYEES_MANAGE,
        DEVICES_MANAGE,
        ROLES_MANAGE,
        TEAM_VIEW,
        BRANCHES_MANAGE,
        SETTINGS_VIEW,
        SETTINGS_MANAGE,
        FACE_REVIEW,
    }
)

SUPER_ADMIN_ROLE = "Super Admin"
