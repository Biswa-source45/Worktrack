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
ATTENDANCE_VIEW_ALL = "attendance.view_all"
ATTENDANCE_OVERRIDE = "attendance.override"
PUNCHOUT_APPROVE = "punchout.approve"
TASKS_CREATE = "tasks.create"
TASKS_VIEW_ALL = "tasks.view_all"

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
        ATTENDANCE_VIEW_ALL,
        ATTENDANCE_OVERRIDE,
        PUNCHOUT_APPROVE,
        TASKS_CREATE,
        TASKS_VIEW_ALL,
    }
)

SUPER_ADMIN_ROLE = "Super Admin"
