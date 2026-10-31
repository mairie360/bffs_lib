import { PROJECT_TASK_MANAGER_ROLES, hasRole, roleKey } from '../src';

describe('role names (MAIR-525)', () => {
  test.each([
    ['ROLE_RESPONSABLE', 'responsable'],
    [' Admin ', 'admin'],
    ['Employé', 'employe'],
    ['role-maire', 'maire'],
    ['Super User', 'superuser'],
  ])('roleKey(%p) is %p', (role, key) => {
    expect(roleKey(role)).toBe(key);
  });

  test('hasRole compares normalized names', () => {
    expect(hasRole(['User', 'ROLE_ADMIN'], 'admin')).toBe(true);
    expect(hasRole(['Utilisateur'], 'admin', 'maire')).toBe(false);
    expect(hasRole([], 'admin')).toBe(false);
  });

  test('task managers are the Admin, Maire and Responsable of BFF_Project, aliases included', () => {
    expect(['Admin', 'Administrateur', 'Maire', 'Mayor', 'Responsable', 'Manager'].every((role) => hasRole([role], ...PROJECT_TASK_MANAGER_ROLES))).toBe(true);
    expect(['User', 'Guest', 'Employé'].some((role) => hasRole([role], ...PROJECT_TASK_MANAGER_ROLES))).toBe(false);
  });
});
