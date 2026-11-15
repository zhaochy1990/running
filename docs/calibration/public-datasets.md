# 公开跑步校准数据研究与采用决定（2026-11-15）

本次实际上网核查作者、机构与数据托管平台；下载文件仅保留 `/tmp/stride-983/public-data/`，不提交原始数据、不再分发。用途按用户明确授权：开源公益项目的本地非商业算法研究。**采用 OSF 真实60分钟实验、Trinity 乳酸阶段测试、FitRec 小样本，分别验证连续片段/努力协议、独立HR参考语义、自然采样质量；继续用授权生产只读纵向数据做真实离线回测。** 公开数据补充工程证据，并未填满全部发布准确性门槛；这些缺口只阻塞上线，不阻塞 candidate 代码实现，active v3 保持不变。

## 推荐矩阵

| 数据 | 访问与许可核查 | 已拿到的真实数据 | 可以直接验证 | 不能声称 |
| --- | --- | --- | --- | --- |
| [OSF 8d35z：近全力60min跑台](https://osf.io/8d35z/) | 公开API与文件无登录可读；node_license=null；[论文](https://pmc.ncbi.nlm.nih.gov/articles/PMC9310469/) CC-BY4及文内data CC0通知，外链工作簿未单列许可；本地研究、不再分发 | 7,022,663B xlsx，21人75,632速度/距离点、12个5min HR/RPE | **采用**：R1时间/距离/速度口径，R2明确近全力协议，R3区分HR均值与LTHR；真实60min表现提取 | 无此前训练历史；把本场同时放输入及label会泄漏；平均HR不是生理LTHR，不能据此证明预测60min准确率 |
| [Trinity GXT v2](https://zenodo.org/records/10841412) | [作者API](https://zenodo.org/api/records/10841412) CC-BY4；页内另限research/education，与本次本地研究用途相符；无登录 | 6,736,548B zip，284跑步测试；276场/2501个完整四变量stage；283个非空作者速度及HR阈值 | **采用**：实测乳酸支持的独立lab参考、HR证据分级；阶段数据不得伪装逐秒测量 | 作者Tlac是乳酸两段回归breakpoint，非直接60min、非恒定负荷MLSS；稳定participant ID缺失，不能计作284独立用户 |
| [FitRec/Endomondo 官方](https://mcauleylab.ucsd.edu/public_datasets/gdrive/fitrec/FitRec-Project.html) | academic-use-only、禁止商业及再分发；按已授权本地非商业研究取样，保留该限制，不扩大解释成任意用途 | raw gz全量1,995,378,519B；本次仅393,216压缩B，前34记录取3跑步/1用户/1500点 | **采用小样本**：稀疏GPS/HR/Unix时间适配、缺字段与HR异常降级 | 没有全力或LTHR标签；本次跑步记录无speed/distance；不能当设备距离异常的直接实测对照 |
| [PhysioNet Malaga v1.0.1](https://physionet.org/content/treadmill-exercise-cardioresp/1.0.1/) | 当前页面展示Contributor Review Health Data License/DUA1.5；[文件LICENSE](https://physionet.org/content/treadmill-exercise-cardioresp/1.0.1/LICENSE.txt)又是CC-BY-NC-SA4，页面与文件不一致；未替用户签DUA/声明培训资格 | 作者说明992 maximal GXT/857人；逐呼吸speed/HR/gas；22.1MB CSV/6.3MB ZIP；本次仅读说明/许可 | 暂列后备：若访问条件厘清可验证非等间隔HR与递增运动恢复 | 无血乳酸、无作者标定LTHR/VT label、时长中位1093s；“maximal递增测试”不等于每个stage全力或60min |
| [RSU HIIT RZYMHE](https://dataverse.rsu.lv/dataset.xhtml?persistentId=doi:10.48510/FK2/RZYMHE) | [官方API](https://dataverse.rsu.lv/api/datasets/:persistentId/?persistentId=doi:10.48510/FK2/RZYMHE) CC-BY-NC-ND4；明确restricted/contact authors；实际数据GET=403；未请求/签署 | 只下载8461B codebook；数据1310454B，6×2min、被动恢复、HR/gas5s均值与离散乳酸 | 后备：恢复段不能拼连续表现，HIIT不是60min锚点 | 没有获得实际数据，不计实测覆盖；恒定work速度不等于恒定全程或阈值真值 |
| [RSU running kinematics K6W5E5](https://science.rsu.lv/en/datasets/treadmill-running-kinematics-and-heart-rate-dataset-across-experi/) | [官方API](https://dataverse.rsu.lv/api/datasets/:persistentId/?persistentId=doi:10.48510/FK2/K6W5E5) CC-BY-NC-ND4、restricted/request collaboration；仅取公开README | HR文件576477B/27452行，kinematics15492843B/158999行；participant/task/speed/HR，实际数据未获取 | 暂不采用：可供受控次极限HR负例，但当前已有生产样本 | 无乳酸/60min、HR表未列时间戳，不是长期历史 |
| 公开Strava长距离论文 | [作者研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC8506252/)158117马拉松用户与此前约23周训练，依Strava data-sharing agreement；[另一原文](https://link.springer.com/content/pdf/10.1007/s11257-021-09299-3.pdf)明确不能分享/发布raw | 未找到作者许可的公开raw下载；大小未知，未下载 | 不采用为可立即运行数据；方法参考即可 | 论文公开不等于训练流公开；不能抓用户公开活动冒充获许可数据集 |
| [London Marathon 2018–23](https://zenodo.org/records/10960982) | [API](https://zenodo.org/api/records/10960982)CC-BY4，13,224,728B xlsx，无登录 | 只核查metadata；完赛成绩/名次，排除elite/DNF | 可做完赛分布合理性参考 | 缺同人训练流与HR，不能直接跑当前校准输入/独立历史预测 |

## 核查后排除的相似结果

- [Zenodo “Dataset Strava” 17087436](https://zenodo.org/records/17087436)标题容易误导；实际有界读CSV发现字段为tweet/conversation/text/retweet等，是社交媒体文本，不是运动时间序列。文件4,130,146B、CC-BY4；仅读65,536B header/prefix后停止。
- [Garmin marathon aggregated 19393810](https://zenodo.org/records/19393810)为16参与者100聚合样本、CC-BY4；下载9321B CSV核查只有聚合活动数量、平均速度/HR、累计时长/距离、马拉松时间，无稳定participant/event timestamp或逐次历史，不能做用户分组时序回测；设备zone百分比也不是lab label。
- [Figshare 7240571](https://api.figshare.com/v2/articles/7240571)有173152B workbook、CC-BY4、乳酸与time trial，但作者描述明确为EPO临床试验的**自行车**数据，本轮不跨运动当跑步真值。[Figshare collection 7711532](https://api.figshare.com/v2/collections/7711532/articles)是强度框架问卷/分析，不是跑步乳酸测试原始流。
- [Zenodo 17702665](https://zenodo.org/records/17702665)15,254B xlsx/CC-BY4已实际查看：16 athlete、vMLaSS与30min的0/10/20/30乳酸、无HR及逐秒速度。它研究lactate-minimum速度下的稳定性，不能把名为MLaSS的速度自动认作已验证最高稳态或60min。缺同人多强度恒定负荷测试及长期训练，暂不整合。
- [Sensors 2021 10/20/30/60min试验](https://www.mdpi.com/1424-8220/21/2/582)最接近跨时长留出，但作者明确数据仅on request、未公开；只提供论文中均值/图不能替代个体数据。[Calgary MLSS running](https://www.mdpi.com/1424-8220/23/21/8729)真实恒定速度多次测试，但原始数据亦需request，补充材料主要汇总结果；本次未联系任何作者。

## 本地实测与可运行适配

### OSF：最有用的真实连续片段集

原文件来自[公开文件](https://osf.io/download/3rq4t/)，[API固定文件版本](https://api.osf.io/v2/nodes/8d35z/files/osfstorage/)记录2022-06-22创建/修改与hash；这仅证明公开文件版本可得时间，不证明2019测试当时系统可得。工作簿原始表为participant/test/time/distance/velocity/power等；**raw无HR列**，HR/RPE在另一表为5min汇总。实验[作者协议](https://pmc.ncbi.nlm.nih.gov/articles/PMC9310469/)要求尽可能覆盖最多距离、近全力60min、跑台1%坡度；这是直接现场协议参考，不能升级为乳酸LTHR。

本地`inspect_osf.py`输出：

- `osf-60min-points.csv`：`participant,source_elapsed_s,distance_m,speed_mps,five_min_bin`；源距离km×1000、速度km/h÷3.6；不取GPS、不补HR、不造绝对日期。
- `osf-60min-summary.json`：21个participant的12个5min HR、RPE、velocity及summary。源行有时序乱序，必须先按源elapsed稳定排序，保留乱序审计；18组3601点覆盖3600s，另3组覆盖3601/3603/3607s，不能静默强行变3600s。
- `osf-60min-consistency.json`：按真实时间排序，累计距离差与速度梯形积分的相对差绝对值中位0.000607%、最大0.001523%；summary速度与raw距离速度的绝对相对差中位0.9936%、最大3.4815%。后者未经解释，不能挑更快的作真值。这正适合R1口径冲突回归。

这是本次最直接的60min测试数据，仍**不能**把该60min整场既当模型输入又当独立准确率label。没有此前自然训练流，宜用于分段恢复/完整分母/来源可追溯及明确努力协议测试；不替代T8用户历史留出。另勿将5min HR均值重复300次制造100%逐秒覆盖。

### Trinity：阶段数据与独立lab标签

本地`inspect_trinity.py`只用Python标准库解析xlsx，不执行宏/公式；`Data_Summary.xlsx.sport`筛Running，不能靠文件名/“Actual Power”列名推断运动。284 Running中266个stage首列也误写“Actual Power”、18个写“Velocity”；按作者跑步protocol解释km/h，保留该源问题。输出完整四变量stage为276测试/2501行，未完整的stage记在`trinity-inspection.json`；这不是宣称其它测试完全不可用。

`trinity-running-stages.csv`保留休息stage、`duration_s=180`与`duration_source=published_protocol_not_recorded_sample_times`；HR=末1min平均、乳酸=第2min采血，不造逐秒样本。`trinity-running-labels.json`从作者结果页分离`Load @ Tlac`/`Velocity @ Tlac`、`HR @ Tlac`，二者均283非空，保留test原文件hash。该label由实测血乳酸分段回归形成，独立于我们速度推HR，可做lab-reference语义验证，不能改名LT2或60min能力。没有可核验的稳定participant ID，分组独立性不足；事件test_date有而历史first-available无，仅event-date retrospective。

### FitRec：仅有界小样本

`sample_fitrec.py`通过HTTP Range+gzip增量流，最多8MiB压缩读取/90s，找到前3个完整` sport=run`后立即停止；实际393216B、扫描34记录。官方raw虽名JSON实际为Python字面量，脚本采用严格AST白名单数据解析，禁止函数调用/属性/名字/任意代码求值，不用pickle。样本3活动来自**1用户**，各500点，时长3888/5467/3222s，采样间隔中位8/11/6s；HR最高227/249/248，必须经过质量规则。样本无speed/distance，只能由GPS派生距离且标明derived；没有设备累计距离就保持missing，不能假造来通过T2一致性。原始userId/id只本地使用，effort=unknown，不能从sport/run或高HR升级全力。

### 复现命令与hash

以下从仓库根运行；仅采样脚本访问官方网络，Go命令不联网、不读DB。Python仅标准库，不安装XLSX依赖。原始数据与逐项报告留在Git外。先分别从[Trinity作者下载项](https://zenodo.org/records/10841412)取得 `data_v2.zip` 保存为 `trinity-data_v2.zip`，从[OSF固定文件](https://osf.io/download/3rq4t/)取得 `osf-60min-raw.xlsx`；与下表原字节hash一致后解压Trinity到 `trinity/`（内含 `data/Data_Summary.xlsx`），不要执行外部文件。

```sh
PUBLIC_DATA_DIR=/tmp/stride-983/public-data
mkdir -p "$PUBLIC_DATA_DIR"
python3 scripts/calibration/public_data/sample_fitrec.py --directory "$PUBLIC_DATA_DIR"
python3 scripts/calibration/public_data/inspect_trinity.py --directory "$PUBLIC_DATA_DIR"
python3 scripts/calibration/public_data/inspect_osf.py --directory "$PUBLIC_DATA_DIR"
(cd src/go && go build -o "$PUBLIC_DATA_DIR/stride-public" ./cmd/stride)
CODE_VERSION=$(git rev-parse HEAD)
"$PUBLIC_DATA_DIR/stride-public" calibration public-data --format fitrec-jsonl --input "$PUBLIC_DATA_DIR/fitrec-running-sample.jsonl" --code-version "$CODE_VERSION" > "$PUBLIC_DATA_DIR/fitrec-report.json"
"$PUBLIC_DATA_DIR/stride-public" calibration public-data --format trinity-stage-csv --input "$PUBLIC_DATA_DIR/trinity-running-stages.csv" --labels "$PUBLIC_DATA_DIR/trinity-running-labels.json" --code-version "$CODE_VERSION" > "$PUBLIC_DATA_DIR/trinity-report.json"
"$PUBLIC_DATA_DIR/stride-public" calibration public-data --format osf-60min-csv --input "$PUBLIC_DATA_DIR/osf-60min-points.csv" --code-version "$CODE_VERSION" > "$PUBLIC_DATA_DIR/osf-report.json"
```

三条Go命令成功生成诊断时均退出 **2**（`status=insufficient`, `release_ready=false`），输入错误退出1。输出锁定原输入/可选label SHA256与代码/strategy/implementation/parameter身份；固定输入和版本可逐字节复现。FitRec按真实Unix时间的上海日分别调用 `EstimateOffline(v3)`，是3次单活动缺失路径smoke，不是1用户完整历史。OSF没有绝对活动日，Trinity没有逐点时钟，因此不造日期或连续样本送入历史估计；保留真实观测供后续纯片段函数检查。

实际运行聚合结果：FitRec 3活动/1500点，速度和距离全部missing，HR>220有43点（保留原值、标示可疑，不据此判全力），最大gap42s；Trinity 276测试/2501原stage，284作者label中speed与HR各283非空、276 label能匹配已提取stage；OSF 21场/75632点，逐点HR全部missing，825次源文件行序回退经稳定排序恢复，重复时间/距离回退均0、最大gap1s；18场覆盖3600s，另3场3601/3603/3607s，未裁剪。stage的gap=0只代表无观测时钟，不能解读为连续采样。

`osf-60min-consistency.json` 是本次额外本地研究审计，不是Go命令计算的准确性验收产物；上文一致性差异仅描述口径，没有作为参考误差通过条件。原始公开数据、逐项报告、身份与轨迹不得提交Git；本页仅保留聚合数和来源hash。

| 本地文件 | 字节 | SHA256 |
| --- | ---: | --- |
| `trinity-data_v2.zip` | 6736548 | `4a1f1f0aa22f3561c43f88a1826e0715cffb27b60e90f9f580c0c3c2dff31904` |
| `trinity-running-stages.csv` | 259574 | `c23140defde9a762ca0ddcbafc2207955d841299dfad7e534ee4bd79e0ec5c76` |
| `trinity-running-labels.json` | 77898 | `bc01b563cad6e81b8ef33afdd0fc120c0f5758945ba0c60394b1a7b8859f8984` |
| `fitrec-running-sample.jsonl` | 见provenance | `1f525cbf32daf2c00d1726bfc2e31b9ab99393346418d941fdac35101568345f` |
| `osf-60min-raw.xlsx` | 7022663 | `f3ba6fdc01cd39f11038d11d71b48a61d700320880e30ca651ecc7121f42153c` |
| `osf-60min-points.csv` | 2497676 | `9e4a13accbe89f85c0e27f8f06f8cddeb34091a7de33f487908e5e3729c2deb9` |

## 仍未覆盖的发布验收

本次没有找到同时具备“足够多独立用户、长期真实训练输入、测试前不可变可得时间、独立60min全力/明确乳酸LTHR标签”的即用公开集。这个结论限定为本次有界检索，不是宣称互联网绝对不存在。生产已冻结数据仍支持252场缺陷回放及21场probable比赛次级参考；其标签/strict可得时间/最终留出规模缺口按既有协议如实保留。

继续candidate实现并以三类公开样本和授权生产只读样本跑确定性/退化回归；T8在独立参考不足时保持`insufficient`，不宣称60min/LTHR准确性已提升、不切换生产v3、不降低事前门槛。不要将“研究找到了lab数据”写成“已有283个可直接验收的独立用户LTHR真值”。
