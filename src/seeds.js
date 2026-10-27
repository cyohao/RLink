'use strict';

// 首次启动时预置的接口：
//   I-01 ~ I-04 按《杀虫库WES系统与昆船烟丝库仓储系统接口对接方案》编写；
//   TUSK 创建任务按《WES与潜伏式AGV调度系统接口对接文档》编写。
// 路径是占位的，昆船给出正式地址后在管理页面修改即可。

const json = (v) => JSON.stringify(v, null, 2);

const fail = (code, msg, data = null) => ({ status: 200, headers: {}, body: json({ code, msg, data }) });

const VALIDATION_1002 = fail('1002', '{{error}}');

// 默认停用，需要联调鉴权时再启用
const AUTH_SCENARIO = {
  name: '鉴权失败（Token 不是 mock-token）',
  enabled: false,
  match: 'all',
  conditions: [{ field: 'headers.x-auth-token', op: 'ne', value: 'mock-token' }],
  response: fail('1001', '鉴权失败'),
};

const str = (name, maxLength, required = true) => ({ in: 'body', name, type: 'string', required, maxLength });

module.exports = [
  {
    name: 'I-01 烟箱特征码规则同步',
    description: '全量返回特征码字典',
    method: 'POST',
    path: '/wms/api/feature-codes',
    scenarios: [AUTH_SCENARIO],
    response: {
      status: 200,
      body: json({
        code: '0',
        msg: 'success',
        data: {
          featureCodes: [
            { featureCode: '102000', name: '木质烟箱使用次数1-10', description: '木质烟箱使用次数1-10', status: 'ENABLED' },
            { featureCode: '102001', name: '木质烟箱使用次数11-20', description: '木质烟箱使用次数11-20', status: 'ENABLED' },
            { featureCode: '103000', name: '木质烟箱使用次数21以上', description: '木质烟箱使用次数21以上', status: 'DISABLED' },
          ],
        },
      }),
    },
  },
  {
    name: 'I-02 可出库空箱库存查询',
    description: '随机生成 30 个货位的空箱库存，批次号有空值和几个历史批次，用来测试轮换选箱',
    method: 'POST',
    path: '/wms/api/inventory/empty-boxes',
    scenarios: [AUTH_SCENARIO],
    response: {
      status: 200,
      body: json({
        code: '0',
        msg: 'success',
        data: {
          locations: {
            $repeat: 30,
            $item: {
              featureCode: "{{pick '102000' '102001'}}",
              locationCode: "{{concat '01' (pad (randomInt 1 20) 2) (pad (randomInt 1 40) 3)}}",
              itemCode: '20',
              oldestInTime: '{{now}}',
              batchNo: "{{pick '' '' 'SC202610-01' 'SC202612-01'}}",
              quantity: 2,
            },
          },
        },
      }),
    },
  },
  {
    name: 'I-03 空烟箱出库任务申请',
    description: '按申请数量生成垛明细（2 箱/垛，奇数时最后一垛为单箱）。数量超过 200 时返回 3001 库存不足',
    method: 'POST',
    path: '/wms/api/task/out',
    rules: [
      str('taskNo', 32),
      str('batchNo', 32),
      str('featureCode', 32),
      { in: 'body', name: 'quantity', type: 'integer', required: true },
      str('stationCode', 16),
    ],
    validationResponse: VALIDATION_1002,
    scenarios: [
      AUTH_SCENARIO,
      {
        name: '可出库数量不足（申请数量 > 200）',
        match: 'all',
        conditions: [{ field: 'body.quantity', op: 'gt', value: '200' }],
        response: fail('3001', '可出库数量不足', { acceptedQty: 200 }),
      },
      {
        name: '强制返回系统内部错误',
        enabled: false,
        conditions: [],
        response: fail('5001', '系统内部错误'),
      },
    ],
    response: {
      status: 200,
      body: json({
        code: '0',
        msg: 'success',
        data: {
          wmsTaskNo: "{{concat 'WMS' (now 'YYYYMMDD') (pad (seq 'out') 6)}}",
          acceptedQty: '{{body.quantity}}',
          stacks: {
            $repeat: '{{ceil (div body.quantity 2)}}',
            $item: {
              locationCode: "{{concat '01' (pad (randomInt 1 20) 2) (pad (randomInt 1 40) 3)}}",
              featureCode: '{{body.featureCode}}',
              upBoxCode: "{{if (gt (mul $no 2) body.quantity) '' (concat 'B' (pad (seq 'box') 6))}}",
              downBoxCode: "{{concat 'B' (pad (seq 'box') 6)}}",
            },
          },
        },
      }),
    },
  },
  {
    name: 'I-04 空烟箱回库任务申请',
    description: 'taskType=KILL 时 featureCode 必填；可启用「无可用库位」场景模拟 3002',
    method: 'POST',
    path: '/wms/api/task/back',
    rules: [
      str('taskNo', 32),
      { in: 'body', name: 'taskType', type: 'string', required: true, enum: ['KILL', 'CLEAN'] },
      str('batchNo', 32),
      str('featureCode', 32, false),
      { in: 'body', name: 'quantity', type: 'integer', required: true },
      str('stationCode', 16),
      str('upBoxCode', 32, false),
      str('downBoxCode', 32),
    ],
    validationResponse: VALIDATION_1002,
    scenarios: [
      AUTH_SCENARIO,
      {
        name: 'KILL 回库缺少特征码',
        match: 'all',
        conditions: [
          { field: 'body.taskType', op: 'eq', value: 'KILL' },
          { field: 'body.featureCode', op: 'notExists', value: '' },
        ],
        response: fail('1002', 'taskType 为 KILL 时 featureCode 必填'),
      },
      {
        name: '强制返回无可用库位',
        enabled: false,
        conditions: [],
        response: fail('3002', '无可用库位'),
      },
    ],
    response: {
      status: 200,
      body: json({
        code: '0',
        msg: 'success',
        data: {
          wmsTaskNo: "{{concat 'WMS' (now 'YYYYMMDD') (pad (seq 'back') 6)}}",
          acceptedQty: '{{body.quantity}}',
        },
      }),
    },
  },
  {
    name: 'TUSK 创建任务',
    description: '潜伏式 AGV 调度系统（TUSK）创建任务，WES → TUSK。targets 必填且至少一个点位',
    method: 'POST',
    path: '/rpc/task/create',
    rules: [
      { in: 'body', name: 'taskId', type: 'string' },
      { in: 'body', name: 'targets', type: 'array', required: true },
      { in: 'body', name: 'configId', type: 'string' },
      { in: 'body', name: 'priority', type: 'integer' },
      { in: 'body', name: 'containerId', type: 'string' },
      { in: 'body', name: 'containerTypeId', type: 'integer' },
      { in: 'body', name: 'robotId', type: 'string' },
      { in: 'body', name: 'robotGroup', type: 'string' },
    ],
    validationResponse: { status: 200, headers: {}, body: json({ code: 400, msg: '{{error}}' }) },
    scenarios: [
      {
        name: 'targets 为空',
        match: 'all',
        conditions: [{ field: 'body.targets.0', op: 'notExists', value: '' }],
        response: { status: 200, headers: {}, body: json({ code: 400, msg: 'targets 不能为空' }) },
      },
      {
        name: '强制返回创建失败',
        enabled: false,
        conditions: [],
        response: { status: 200, headers: {}, body: json({ code: 400, msg: '任务创建失败' }) },
      },
    ],
    response: { status: 200, headers: {}, body: json({ code: 200, msg: 'success' }) },
  },
];
