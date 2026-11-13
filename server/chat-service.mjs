import { createChatRoom } from "./chat.mjs";
import { createChatAudioVideo } from "./chat-audio-video.mjs";
import { createCloudsyncIdentity } from "./chat-auth.mjs";
import { chatSocketPath, serveChatControl } from "./chat-control.mjs";
import { createChatImageCheck } from "./chat-image-check.mjs";
import { chatDatabasePath, createChatStore } from "./chat-store.mjs";
import { createChatTextCheck } from "./chat-text-check.mjs";

export function startChat({ root }) {
  const store = createChatStore(chatDatabasePath(root));
  const images = createChatImageCheck({ root });
  const texts = createChatTextCheck({ root });
  const room = createChatRoom({
    store,
    identify: createCloudsyncIdentity(),
    checkImage: images.check,
    prepareMedia: createChatAudioVideo().prepare,
    checkText: texts.check,
    warmText: texts.warm,
  });
  const stopControl = serveChatControl(chatSocketPath(root), room.control);
  return {
    handle: room.handle,
    close() {
      stopControl();
      room.close();
      images.close();
      texts.close();
      store.close();
    },
  };
}
