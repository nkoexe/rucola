import type { MessageType, Participant } from './models';
import type { RucolaRepository } from './repository';

export class SaveSetup {
  constructor(private readonly repository: RucolaRepository) {}

  execute(input: {
    partnerNickname: string;
    ownName: string;
    togetherSince: number | null;
    partnerColor?: string;
  }): Promise<void> {
    return this.repository.saveSetup(input);
  }
}

export class SendMessage {
  constructor(private readonly repository: RucolaRepository) {}

  execute(input: {
    type: MessageType;
    body: string;
    mediaReference?: string | null;
  }) {
    return this.repository.sendMessage(input);
  }
}

export class GetActiveMessage {
  constructor(private readonly repository: RucolaRepository) {}

  execute(participant: Participant) {
    return this.repository.getActiveMessage(participant);
  }
}

export class GetHistory {
  constructor(private readonly repository: RucolaRepository) {}

  async execute() {
    const messages = await this.repository.getMessages();
    return messages.filter((message) => !message.isActive);
  }
}
