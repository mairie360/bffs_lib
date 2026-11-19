import {
  CORE_ROLES, PROJECT_TASK_MANAGER_ROLES, canonicalRole, canonicalRoles, hasRole, isAdminRole, isManagerRole, roleKey,
} from '../src';

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

describe('one role rule for every BFF (MAIR-689)', () => {
  // The names the database seeds (Admin, Maire, Responsable, User, Guest), their aliases and spellings, and custom roles.
  test.each([
    ['Admin', 'Admin', true, true],
    ['Administrateur', 'Admin', true, true],
    ['administrator', 'Admin', true, true],
    ['ROLE_ADMIN', 'Admin', true, true],
    [' role-admin ', 'Admin', true, true],
    ['Maire', 'Maire', false, true],
    ['Mayor', 'Maire', false, true],
    ['Responsable', 'Responsable', false, true],
    ['ROLE_RESPONSABLE', 'Responsable', false, true],
    ['Manager', 'Responsable', false, true],
    ['User', 'User', false, false],
    ['Employé', 'User', false, false],
    ['Guest', 'Guest', false, false],
    ['Invité', 'Guest', false, false],
    ['Stagiaire', null, false, false],
    ['Super Admin', null, false, false],
    ['', null, false, false],
    ['constructor', null, false, false],
    ['__proto__', null, false, false],
  ] as const)('%p is %p (admin: %p, manager: %p)', (role, core, admin, manager) => {
    expect(canonicalRole(role)).toBe(core);
    expect(isAdminRole(role)).toBe(admin);
    expect(isManagerRole(role)).toBe(manager);
  });

  test.each([[undefined], [null], [42], [{}], [['admin']]])('a value that is not a string (%p) is no role', (value) => {
    expect(canonicalRole(value)).toBeNull();
    expect(isAdminRole(value)).toBe(false);
    expect(isManagerRole(value)).toBe(false);
  });

  test('canonicalRoles keeps the Core roles, widest first, without duplicates', () => {
    expect(canonicalRoles(['Guest', 'role_maire', 'Stagiaire', 'Mayor', 42, 'Administrateur'])).toEqual(['Admin', 'Maire', 'Guest']);
    expect(canonicalRoles([])).toEqual([]);
    expect(CORE_ROLES).toEqual(['Admin', 'Maire', 'Responsable', 'User', 'Guest']);
  });

  test('the task manager list is the managers of isManagerRole', () => {
    expect(PROJECT_TASK_MANAGER_ROLES.every((role) => isManagerRole(role))).toBe(true);
    expect([...PROJECT_TASK_MANAGER_ROLES].sort()).toEqual(
      ['admin', 'administrateur', 'administrator', 'maire', 'manager', 'mayor', 'responsable'],
    );
  });
});
