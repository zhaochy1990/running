/**
 * profileFields.ts 自检：`node utils/profileFields.check.mts`（或 `npm test`）。
 *
 * 重点是**契约**而不是实现：这几个 token 必须和后端 Go `profileInput` 的 oneof
 * 逐字一致，改错一个字母后端就 422。所以这里把字面量钉死 —— 谁改了它们，这个
 * 检查先红，而不是等用户提交资料时才发现。
 */
import { AGE_OPTIONS, AGE_VALUES, SEX_OPTIONS, SEX_VALUES, missingProfileFields } from './profileFields.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— 与 Go profileInput 的 oneof 对齐的契约 ——
eq(SEX_VALUES, ['male', 'female', 'other'], 'sex tokens must match Go oneof');
eq(
  AGE_VALUES,
  ['unknown', 'lt_6m', '6m_1y', '1y_3y', '3y_plus'],
  'running_age_range tokens must match Go oneof',
);

// —— 展示文案与提交值一一对应（picker 的 index 是两者之间的桥） ——
eq(SEX_OPTIONS.length, SEX_VALUES.length, 'sex options/values must line up');
eq(AGE_OPTIONS.length, AGE_VALUES.length, 'age options/values must line up');

// —— 必填校验：缺什么就报什么，别只报一句"请填写完整资料" ——
const complete = {
  display_name: '跑者',
  dob: '1990-01-01',
  sex: 'male',
  height_cm: 175,
  weight_kg: 68,
  running_age_range: '3y_plus',
} as const;
eq(missingProfileFields(complete), [], 'complete profile has nothing missing');
eq(missingProfileFields({}), ['昵称', '生日', '性别', '身高', '体重', '跑步年限'], 'empty reports every field');
eq(missingProfileFields({ ...complete, display_name: '   ' }), ['昵称'], 'whitespace-only name is missing');
eq(missingProfileFields({ ...complete, height_cm: 0 }), ['身高'], 'zero height is missing');
eq(missingProfileFields({ ...complete, weight_kg: 0 }), ['体重'], 'zero weight is missing');
eq(missingProfileFields({ ...complete, dob: '' }), ['生日'], 'empty dob is missing');

console.log('profileFields.check: OK');
