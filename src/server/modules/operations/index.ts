/**
 * operations 模块公共出口（架构第 67.2 节）。
 */

export {
  createOperationsService,
  operationsService,
  resetOperationsService,
  operationDigest,
  recordOperationInTx,
} from './service';

export type { OperationsService, OperationRecordInput } from './service';
