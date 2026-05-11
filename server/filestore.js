// Handles temporary storage of file chunks in memory
// for active transfers. Large files are streamed
// chunk by chunk so we never hold the full file in RAM.

const transfers = new Map();
// transferId → {
//   senderId, receiverId, groupId,
//   filename, fileSize,
//   status: 'pending'|'active'|'done'|'cancelled'
// }

export function create(transferId, senderId,
                        receiverId, groupId,
                        filename, fileSize) {
  transfers.set(transferId, {
    senderId, receiverId, groupId,
    filename, fileSize,
    status: 'pending'
  });
}

export function get(transferId) {
  return transfers.get(transferId) ?? null;
}

export function setStatus(transferId, status) {
  const t = transfers.get(transferId);
  if (t) t.status = status;
}

export function remove(transferId) {
  transfers.delete(transferId);
}

export function isActive(transferId) {
  return transfers.get(transferId)
    ?.status === 'active';
}