// 由 src/go/internal/api/pace_race_templates.json 同步，paceCalculator.check.mts 校验两份数据一致。
import type { PaceRaceTemplate } from './pace-calculator';

export const BUILTIN_PACE_RACE_TEMPLATES: PaceRaceTemplate[] = [
    {
      "key": "chongqing",
      "name": "重庆马拉松",
      "distance_km": 42.195,
      "difficulty": "困难",
      "terrain": "多坡道",
      "description": "赛道起伏大，35-36km有400米大坡，适合有坡道训练经验的跑者",
      "segments": [
        {
          "start_km": 0,
          "end_km": 5,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "起步热身，保持稳定"
        },
        {
          "start_km": 5,
          "end_km": 26,
          "pace_delta_seconds": 0,
          "terrain": "rolling",
          "note": "返程路段，坡度适中"
        },
        {
          "start_km": 26,
          "end_km": 35,
          "pace_delta_seconds": 5,
          "terrain": "uphill",
          "note": "持续缓上坡，控制心率"
        },
        {
          "start_km": 35,
          "end_km": 36,
          "pace_delta_seconds": 15,
          "terrain": "steep",
          "note": "400米大坡，降速保体力"
        },
        {
          "start_km": 36,
          "end_km": 42.195,
          "pace_delta_seconds": -5,
          "terrain": "downhill",
          "note": "长缓下坡，全力冲刺"
        }
      ]
    },
    {
      "key": "beijing",
      "name": "北京马拉松",
      "distance_km": 42.195,
      "difficulty": "中等",
      "terrain": "较平坦",
      "description": "经典赛道，前半程下坡为主，后半程略有上坡",
      "segments": [
        {
          "start_km": 0,
          "end_km": 5,
          "pace_delta_seconds": -3,
          "terrain": "downhill",
          "note": "天安门出发，缓下坡"
        },
        {
          "start_km": 5,
          "end_km": 21,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "长安街路段，平坦"
        },
        {
          "start_km": 21,
          "end_km": 30,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "奥林匹克公园，平坦"
        },
        {
          "start_km": 30,
          "end_km": 38,
          "pace_delta_seconds": 3,
          "terrain": "rolling",
          "note": "略有起伏"
        },
        {
          "start_km": 38,
          "end_km": 42.195,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "鸟巢冲刺"
        }
      ]
    },
    {
      "key": "shanghai",
      "name": "上海马拉松",
      "distance_km": 42.195,
      "difficulty": "简单",
      "terrain": "平坦",
      "description": "全程几乎无坡道，适合追求PB的跑者",
      "segments": [
        {
          "start_km": 0,
          "end_km": 10,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "外滩起跑，稳定配速"
        },
        {
          "start_km": 10,
          "end_km": 21,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "南京路段，保持节奏"
        },
        {
          "start_km": 21,
          "end_km": 32,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "中段平稳推进"
        },
        {
          "start_km": 32,
          "end_km": 42.195,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "最后10公里冲刺"
        }
      ]
    },
    {
      "key": "xiamen",
      "name": "厦门马拉松",
      "distance_km": 42.195,
      "difficulty": "简单",
      "terrain": "沿海平坦",
      "description": "最美赛道，沿海岸线奔跑，全程平坦，注意海风",
      "segments": [
        {
          "start_km": 0,
          "end_km": 10,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "会展中心出发"
        },
        {
          "start_km": 10,
          "end_km": 21,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "环岛路，风景优美"
        },
        {
          "start_km": 21,
          "end_km": 32,
          "pace_delta_seconds": 2,
          "terrain": "flat",
          "note": "可能遇到顶风"
        },
        {
          "start_km": 32,
          "end_km": 42.195,
          "pace_delta_seconds": -2,
          "terrain": "flat",
          "note": "顺风冲刺"
        }
      ]
    },
    {
      "key": "wuhan",
      "name": "武汉马拉松",
      "distance_km": 42.195,
      "difficulty": "中等",
      "terrain": "有桥坡",
      "description": "两次过江，大桥坡度需注意配速调整",
      "segments": [
        {
          "start_km": 0,
          "end_km": 8,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "江汉路起跑"
        },
        {
          "start_km": 8,
          "end_km": 12,
          "pace_delta_seconds": 8,
          "terrain": "uphill",
          "note": "长江大桥上坡"
        },
        {
          "start_km": 12,
          "end_km": 16,
          "pace_delta_seconds": -5,
          "terrain": "downhill",
          "note": "大桥下坡"
        },
        {
          "start_km": 16,
          "end_km": 28,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "武昌段平坦"
        },
        {
          "start_km": 28,
          "end_km": 32,
          "pace_delta_seconds": 6,
          "terrain": "uphill",
          "note": "二桥上坡"
        },
        {
          "start_km": 32,
          "end_km": 36,
          "pace_delta_seconds": -3,
          "terrain": "downhill",
          "note": "二桥下坡"
        },
        {
          "start_km": 36,
          "end_km": 42.195,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "汉口冲刺"
        }
      ]
    },
    {
      "key": "wuxi",
      "name": "无锡马拉松",
      "distance_km": 42.195,
      "difficulty": "简单",
      "terrain": "极平坦",
      "description": "著名PB赛道，全程几乎零坡度，组织优秀",
      "segments": [
        {
          "start_km": 0,
          "end_km": 10,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "太湖广场起跑"
        },
        {
          "start_km": 10,
          "end_km": 21,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "沿太湖跑，平坦"
        },
        {
          "start_km": 21,
          "end_km": 32,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "保持配速"
        },
        {
          "start_km": 32,
          "end_km": 42.195,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "冲刺PB"
        }
      ]
    },
    {
      "key": "hangzhou",
      "name": "杭州马拉松",
      "distance_km": 42.195,
      "difficulty": "中等",
      "terrain": "有起伏",
      "description": "西湖美景，部分路段有缓坡",
      "segments": [
        {
          "start_km": 0,
          "end_km": 8,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "黄龙体育场起跑"
        },
        {
          "start_km": 8,
          "end_km": 15,
          "pace_delta_seconds": 3,
          "terrain": "rolling",
          "note": "西湖周边，略有起伏"
        },
        {
          "start_km": 15,
          "end_km": 25,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "钱塘江边，平坦"
        },
        {
          "start_km": 25,
          "end_km": 35,
          "pace_delta_seconds": 0,
          "terrain": "flat",
          "note": "滨江段"
        },
        {
          "start_km": 35,
          "end_km": 42.195,
          "pace_delta_seconds": 2,
          "terrain": "rolling",
          "note": "回程略有起伏"
        }
      ]
    }
  ];
