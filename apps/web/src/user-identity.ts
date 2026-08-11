export type DepartmentIdentity = {
  departmentName?: string;
  orgPath?: string;
};

/** Organization paths are authorization data, not user-facing department names. */
export function departmentDisplayName(identity?: DepartmentIdentity | null): string {
  return identity?.departmentName?.trim() || '未分配部门';
}
