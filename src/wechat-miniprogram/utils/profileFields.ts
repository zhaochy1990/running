// 基础档案（profile）的字段取值 —— 唯一来源。
//
// 这里的 token 必须与 Go `profileInput` 的 oneof 严格一致
// （`internal/api/users.go`：sex ∈ male|female|other，
// running_age_range ∈ unknown|lt_6m|6m_1y|1y_3y|3y_plus）。传中文标签会直接 422，
// 所以展示文案与提交值分开存：`*_OPTIONS` 给人看，`*_VALUES` 发给后端。
// 自检见 utils/profileFields.check.mts（把这几个字符串钉死，改错会红）。
//
// 放 utils 而不是某个页面里：资料页与 onboarding 资料步都要用，而且纯常量能进
// node 自检（services 层依赖 TS enum，node 的 strip-only 模式导入不了）。

import type { RunningAgeRange } from '../services/profile';

export type Sex = 'male' | 'female' | 'other';

export const SEX_VALUES: Sex[] = ['male', 'female', 'other'];
export const SEX_OPTIONS = ['男', '女', '其他'];

export const AGE_VALUES: RunningAgeRange[] = ['unknown', 'lt_6m', '6m_1y', '1y_3y', '3y_plus'];
export const AGE_OPTIONS = ['暂不透露', '不足 6 个月', '6 个月 – 1 年', '1 – 3 年', '3 年以上'];

/** 提交给 POST /api/users/me/profile 的整表字段（与 Go profileInput 一一对应）。 */
export interface ProfileInput {
  display_name: string;
  dob: string;
  sex: Sex;
  height_cm: number;
  weight_kg: number;
  running_age_range: RunningAgeRange;
}

/** 五项核心字段是否都填了（+ 展示名）—— 决定能不能保存并完成 onboarding。 */
export function missingProfileFields(input: Partial<ProfileInput>): string[] {
  const missing: string[] = [];
  if (!input.display_name?.trim()) missing.push('昵称');
  if (!input.dob) missing.push('生日');
  if (!input.sex) missing.push('性别');
  if (!(typeof input.height_cm === 'number' && input.height_cm > 0)) missing.push('身高');
  if (!(typeof input.weight_kg === 'number' && input.weight_kg > 0)) missing.push('体重');
  if (!input.running_age_range) missing.push('跑步年限');
  return missing;
}
