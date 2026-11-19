// 星期枚举（coach_contract WEEKDAY_VALUES 的 mp 侧镜像）。
//
// 单独成纯模块：表单卡组件与 utils/planJobCards（node 自检链路）都要用它，
// 而 services/master-plan 会连带把 services/request → types/api 的 TS enum
// 拖进 node strip-only 运行时（`.check.mts` 跑不了），故运行时值放这里，
// services/master-plan 只做再导出保持既有 import 面。

export const WEEKDAY_VALUES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAY_VALUES)[number];
