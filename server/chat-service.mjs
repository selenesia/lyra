import { createChatRoom } from "./chat.mjs";
import { createCloudsyncIdentity } from "./chat-auth.mjs";
import { chatSocketPath, serveChatControl } from "./chat-control.mjs";
import { createChatImageCheck } from "./chat-image-check.mjs";
import { chatDatabasePath, createChatStore } from "./chat-store.mjs";

export function startChat({ root }) {
  const store = createChatStore(chatDatabasePath(root));
  const images = createChatImageCheck({ root });
  const room = createChatRoom({ store, identify: createCloudsyncIdentity(), checkImage: images.check });
  const stopControl = serveChatControl(chatSocketPath(root), room.control);
  return {
    handle: room.handle,
    close() {
      stopControl();
      room.close();
      images.close();
      store.close();
    },
  };
}
