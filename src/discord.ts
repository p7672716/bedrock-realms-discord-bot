import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from 'discord.js';
import type { Logger } from './logger.js';
import { RealmApiClient } from './realm-api.js';
import { RealmMonitor } from './monitor.js';
import type { MonitorStatus } from './monitor.js';
import { StateStore } from './store.js';
import type {
  AppConfig,
  DiscordPlayerLink,
  Dimension,
  JoinInfo,
  LocationImage,
  Player,
  PresenceChange,
  RealmConfig,
  RealmEvent,
  RealmInfo,
  SavedLocation,
} from './types.js';
import { normalizePlayerKey, sanitizePlayerName } from './player.js';

type DiscordMessage = {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
};

type EventAsset = {
  fileName: string;
  keys: string[];
};

const LOCATION_IMAGE_OPTION_NAMES = Array.from({ length: 17 }, (_, index) => `image_${String(index + 1).padStart(2, '0')}`);
const LOCATION_IMAGE_WAIT_MS = 60_000;

const EVENT_ASSET_DIR = path.resolve(process.cwd(), 'assets', 'events');
const EVENT_ASSET_FILES = [
  '250-hostile-mobs.png',
  'all-mob-name-easter-eggs.png',
  'cook-everything.png',
  'defeat-ender-dragon.png',
  'defeat-wither.png',
  'diamond-everything.png',
  'easy-and-safe.png',
  'first-abandoned-mineshaft.png',
  'first-ancient-city-found.png',
  'first-badlands-found.png',
  'first-conduit.png',
  'first-crafted-netherite.png',
  'first-diamond-found.png',
  'first-enchantment.png',
  'first-ender-dragon-defeated.png',
  'first-end-portal.png',
  'first-fully-explored-map.png',
  'first-mushroom-field-found.png',
  'first-nether-fortress-found.png',
  'first-nether-portal-lit.png',
  'first-peak-mountain-found.png',
  'first-pillager-outpost-found.png',
  'first-powered-beacon.png',
  'first-wither-defeated.png',
  'first-woodland-mansion-found.png',
  'members-play-free.png',
  'named-mob.png',
  'named-mob-dies.png',
  'new-member.png',
  'persistent-multiplayer-worlds.png',
  'pillager-captain-defeated.png',
  'realm-created.png',
  'slot-switch.png',
] as const;

const EVENT_ASSET_ALIASES: Record<string, string[]> = {
  'first-abandoned-mineshaft.png': ['abandonedmineshaft', 'mineshaft', '廃坑'],
  'first-ancient-city-found.png': ['ancientcity', '古代都市'],
  'first-badlands-found.png': ['badlands', '荒野'],
  'first-crafted-netherite.png': ['netherite', 'ネザライト'],
  'first-diamond-found.png': ['diamond', 'ダイヤモンド'],
  'first-ender-dragon-defeated.png': ['enderdragon', 'エンダードラゴン'],
  'first-mushroom-field-found.png': ['mushroomfield', 'キノコ島'],
  'first-nether-fortress-found.png': ['netherfortress', 'ネザー要塞'],
  'first-nether-portal-lit.png': ['netherportal', 'ネザーポータル'],
  'first-peak-mountain-found.png': ['mountain', '山頂'],
  'first-pillager-outpost-found.png': ['pillageroutpost', 'outpost', '略奪者の前哨基地', '前哨基地'],
  'first-wither-defeated.png': ['wither', 'ウィザー'],
  'first-woodland-mansion-found.png': ['woodlandmansion', '森の洋館'],
  'pillager-captain-defeated.png': ['pillagercaptain', 'captain', '略奪隊長'],
  'named-mob.png': ['名前を付け'],
  'named-mob-dies.png': ['名前付き', '名前を付けたMob'],
  'new-member.png': ['新しいメンバー', '新メンバー'],
};

const EVENT_ASSETS: EventAsset[] = EVENT_ASSET_FILES.map((fileName) => ({
  fileName,
  keys: [fileName.replace(/\.png$/, ''), ...(EVENT_ASSET_ALIASES[fileName] || [])],
}));

export class DiscordService {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  private readonly commands;
  private readonly pendingLocationImageAdds = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly api: RealmApiClient,
    private readonly monitor: RealmMonitor,
    private readonly store: StateStore,
    private readonly log: Logger,
  ) {
    this.commands = buildCommands(config.realms);
    this.client.once('ready', (client) => {
      this.log.info(`Discord connected as ${client.user.tag}`);
    });
    this.client.on('interactionCreate', (interaction) => {
      if (interaction.isChatInputCommand()) void this.handleCommand(interaction);
    });
  }

  async start(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.config.discord.token);
    const route = this.config.discord.guildId
      ? Routes.applicationGuildCommands(this.config.discord.applicationId, this.config.discord.guildId)
      : Routes.applicationCommands(this.config.discord.applicationId);
    await rest.put(route, { body: this.commands.map((command) => command.toJSON()) });
    await this.client.login(this.config.discord.token);
  }

  stop(): void {
    this.client.destroy();
  }

  async notifyPresence(change: PresenceChange): Promise<void> {
    const realm = this.findRealm(change.realmId);
    const channelId = realm.notificationChannelId || this.config.discord.defaultNotificationChannelId;
    if (!channelId) {
      this.log.warn(`No notification channel configured for Realm ${change.realmId}`);
      return;
    }
    const sections: string[] = [];
    const current = await this.formatPlayerNames(change.realmId, change.current);
    if (change.joined.length > 0) {
      for (const player of change.joined) {
        sections.push(`🟢 ${await this.formatPlayerLabel(change.realmId, player)}がログインしました。\n現在：${current}`);
      }
    }
    if (change.left.length > 0) {
      for (const player of change.left) {
        sections.push(`🔴 ${await this.formatPlayerLabel(change.realmId, player)}がログアウトしました。\n現在：${current}`);
      }
    }
    for (const content of sections) await this.sendToChannel(channelId, { content });
  }

  async notifyRealmEvent(event: RealmEvent): Promise<void> {
    const realm = this.findRealm(event.realmId);
    const channelId = realm.notificationChannelId || this.config.discord.defaultNotificationChannelId;
    if (!channelId) {
      this.log.warn(`No notification channel configured for Realm ${event.realmId}`);
      return;
    }
    const message: DiscordMessage = { content: await this.formatEventMessage(event) };
    const asset = resolveEventAsset(event);
    if (asset) {
      message.files = [new AttachmentBuilder(asset.path, { name: asset.fileName })];
      message.embeds = [new EmbedBuilder().setImage(`attachment://${asset.fileName}`)];
    }
    await this.sendToChannel(channelId, message);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(false);
    if (interaction.commandName === 'monitor') {
      try {
        await this.assertCommandAccess(interaction);
        await interaction.deferReply({ ephemeral: true });
        await this.handleMonitorCommand(interaction, subcommand);
      } catch (error) {
        await this.replyCommandError(interaction, error);
      }
      return;
    }
    const realm = this.resolveCommandRealm(interaction);
    if (!realm) {
      await interaction.reply({ content: '監視対象Realmを指定してください。', ephemeral: true });
      return;
    }
    try {
      await this.assertCommandAccess(interaction, realm.id);
      await interaction.deferReply({ ephemeral: true });
      switch (interaction.commandName) {
        case 'online':
          await this.assertMonitoringReady();
          await interaction.editReply({ content: await this.onlineMessage(realm.id, this.monitor.getPlayers(realm.id)) });
          break;
        case 'realm': {
          await this.assertMonitoringReady();
          const [info, joinInfo] = await Promise.all([
            this.api.getRealm(realm.id),
            this.api.getJoinInfo(realm.id),
          ]);
          await interaction.editReply({ content: this.realmMessage(realm, info, joinInfo) });
          break;
        }
        case 'location':
          await this.handleLocationCommand(interaction, realm);
          break;
        case 'player':
          await this.handlePlayerCommand(interaction, realm);
          break;
        default:
          await interaction.editReply({ content: '未対応のコマンドです。' });
      }
    } catch (error) {
      this.log.warn(`Discord command failed: ${interaction.commandName}`, error instanceof Error ? error.message : error);
      await this.replyCommandError(interaction, error);
    }
  }

  private async handleMonitorCommand(interaction: ChatInputCommandInteraction, subcommand: string | null): Promise<void> {
    if (subcommand === 'login') {
      await this.monitor.enable();
      await interaction.editReply({ content: formatMonitorLoginMessage(this.monitor.getStatus()) });
      return;
    }
    if (subcommand === 'logout') {
      await this.monitor.disable();
      await interaction.editReply({ content: '監視を停止しました。監視が必要な機能は無効です。認証情報は保持されるため、再開時は `/monitor login` を実行してください。' });
      return;
    }
    if (subcommand === 'status') {
      await interaction.editReply({ content: formatMonitorStatus(this.monitor.getStatus()) });
      return;
    }
    throw new Error('MONITOR_SUBCOMMAND_UNKNOWN');
  }

  private async handlePlayerCommand(interaction: ChatInputCommandInteraction, realm: RealmConfig): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const guild = await this.requireGuild(interaction);
    const member = await guild.members.fetch(interaction.user.id);
    const playerNameInput = requiredOptionString(interaction, 'player_name');
    if (subcommand === 'link') {
      const livePlayer = this.monitor.getPlayers(realm.id).find((player) => (
        normalizePlayerKey(player.name) === normalizePlayerKey(playerNameInput)
      ));
      const playerName = livePlayer?.name || sanitizePlayerName(playerNameInput);
      if (!playerName || playerName === '不明なプレイヤー') throw new Error('PLAYER_NAME_INVALID');
      const roleName = (interaction.options.getString('role_name') || interaction.user.globalName || interaction.user.username).trim();
      if (!roleName) throw new Error('PLAYER_ROLE_NAME_REQUIRED');

      let role;
      try {
        role = await guild.roles.create({
          name: roleName.slice(0, 100),
          mentionable: false,
          hoist: false,
          reason: `Minecraft player link for ${playerName}`,
        });
        await member.roles.add(role, 'Minecraft player link');
        this.store.createDiscordPlayerLink({
          guildId: guild.id,
          realmId: realm.id,
          discordUserId: interaction.user.id,
          playerId: livePlayer?.id || normalizePlayerKey(playerName),
          playerName,
          xuid: livePlayer?.xuid,
          uuid: livePlayer?.uuid,
          roleId: role.id,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        if (role) await role.delete('Failed to create Minecraft player link').catch(() => undefined);
        if (error instanceof Error && /^PLAYER_LINK_/.test(error.message)) throw error;
        throw new Error('PLAYER_ROLE_CREATE_FAILED');
      }
      await interaction.editReply({ content: `プレイヤー「${playerName}（${role.name}）」とDiscordアカウントを紐づけました。専用ロールはメンション不可です。` });
      return;
    }
    if (subcommand === 'unlink') {
      const link = this.store.getDiscordPlayerLink(guild.id, realm.id, interaction.user.id);
      if (!link) throw new Error('PLAYER_LINK_NOT_FOUND');
      const removed = this.store.deleteDiscordPlayerLink(guild.id, realm.id, interaction.user.id, playerNameInput);
      await member.roles.remove(removed.roleId, 'Minecraft player link removed').catch(() => undefined);
      await interaction.editReply({ content: `プレイヤー「${removed.playerName}」との紐づけを解除しました。` });
      return;
    }
    throw new Error('PLAYER_SUBCOMMAND_UNKNOWN');
  }

  private async assertCommandAccess(interaction: ChatInputCommandInteraction, realmId?: string): Promise<void> {
    const command = interaction.commandName;
    const subcommand = interaction.options.getSubcommand(false);
    if (command === 'player' && subcommand === 'link' && await this.isGuildManager(interaction)) return;
    const guild = await this.requireGuild(interaction);
    const links = realmId
      ? [this.store.getDiscordPlayerLink(guild.id, realmId, interaction.user.id)].filter((link): link is DiscordPlayerLink => Boolean(link))
      : this.store.listDiscordPlayerLinks(guild.id).filter((link) => link.discordUserId === interaction.user.id);
    const link = links[0];
    if (!link) throw new Error('COMMAND_ROLE_REQUIRED');
    const member = await guild.members.fetch(interaction.user.id);
    if (!member.roles.cache.has(link.roleId)) throw new Error('COMMAND_ROLE_REQUIRED');
    const role = await guild.roles.fetch(link.roleId).catch(() => null);
    if (!role) throw new Error('COMMAND_ROLE_REQUIRED');
  }

  private async assertMonitoringReady(): Promise<void> {
    const status = this.monitor.getStatus();
    if (!status.enabled) throw new Error('MONITOR_DISABLED');
    if (status.state === 'auth-required') throw new Error('MONITOR_ACCOUNT_LOGGED_OUT');
    if (status.state === 'account-in-use') throw new Error('MONITOR_ACCOUNT_IN_USE');
    if (status.state !== 'ready') throw new Error('MONITOR_NOT_READY');
  }

  private async isGuildManager(interaction: ChatInputCommandInteraction): Promise<boolean> {
    try {
      const member = await (await this.requireGuild(interaction)).members.fetch(interaction.user.id);
      return member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild);
    } catch {
      return false;
    }
  }

  private async requireGuild(interaction: ChatInputCommandInteraction): Promise<Guild> {
    const guildId = this.config.discord.guildId;
    if (!guildId) throw new Error('DISCORD_GUILD_REQUIRED');
    if (interaction.guildId && interaction.guildId !== guildId) throw new Error('DISCORD_GUILD_INVALID');
    return interaction.guild || await this.client.guilds.fetch(guildId);
  }

  private async replyCommandError(interaction: ChatInputCommandInteraction, error: unknown): Promise<void> {
    this.log.warn(`Discord command failed: ${interaction.commandName}`, error instanceof Error ? error.message : error);
    const code = error instanceof Error ? error.message : String(error);
    const message = interaction.commandName === 'location'
      ? formatLocationError(error)
      : formatCommandError(code);
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: message });
    else await interaction.reply({ content: message, ephemeral: true });
  }

  private async handleLocationCommand(interaction: ChatInputCommandInteraction, realm: RealmConfig): Promise<void> {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();
    if (subcommandGroup === 'image' && subcommand === 'add') {
      const target = requiredOptionString(interaction, 'target');
      const location = this.store.getLocation(realm.id, target);
      if (!location) throw new Error('LOCATION_NOT_FOUND');
      const pendingKey = `${interaction.channelId}:${interaction.user.id}`;
      if (this.pendingLocationImageAdds.has(pendingKey)) throw new Error('LOCATION_IMAGE_ADD_PENDING');
      this.pendingLocationImageAdds.add(pendingKey);
      try {
        await interaction.editReply({
          content: `保存地点「${location.name}」に追加する画像を、このチャンネルへ${LOCATION_IMAGE_WAIT_MS / 1000}秒以内に投稿してください。`,
        });
        const images = await this.waitForLocationImages(interaction);
        const updated = this.store.addLocationImages(realm.id, target, images);
        await interaction.editReply({ content: `保存地点「${updated.name}」に画像を追加しました。` });
      } finally {
        this.pendingLocationImageAdds.delete(pendingKey);
      }
      return;
    }
    if (subcommand === 'delete') {
      const location = this.store.deleteLocation(realm.id, requiredOptionString(interaction, 'name'));
      await interaction.editReply({ content: `保存地点「${location.name}」を削除しました。` });
      return;
    }
    if (subcommandGroup === 'image' && subcommand === 'remove') {
      const location = this.store.removeLocationImage(
        realm.id,
        requiredOptionString(interaction, 'target'),
        requiredOptionInteger(interaction, 'image_index'),
      );
      await interaction.editReply({ content: `保存地点「${location.name}」の画像を削除しました。` });
      return;
    }
    if (subcommand === 'list') {
      await interaction.editReply({ content: formatLocationList(this.store.listLocations(realm.id), '保存地点一覧') });
      return;
    }
    if (subcommand === 'search') {
      const query = requiredOptionString(interaction, 'query');
      await interaction.editReply({
        content: formatLocationList(this.store.searchLocations(realm.id, query), `検索結果：${query}`, query),
      });
      return;
    }
    if (subcommand === 'show') {
      const location = this.store.getLocation(realm.id, requiredOptionString(interaction, 'name'));
      if (!location) throw new Error('LOCATION_NOT_FOUND');
      await interaction.editReply({ content: await this.formatLocationShowMessage(realm.id, location) });
      return;
    }
    if (subcommand === 'save') {
      const location = this.store.createLocation(realm.id, {
        name: requiredOptionString(interaction, 'name'),
        x: requiredOptionNumber(interaction, 'x'),
        y: requiredOptionNumber(interaction, 'y'),
        z: requiredOptionNumber(interaction, 'z'),
        dimension: parseDimension(interaction.options.getString('dimension')),
        note: interaction.options.getString('note') || undefined,
        images: collectLocationImages(interaction),
        createdBy: this.interactionUser(interaction, realm.id),
      });
      await interaction.editReply({ content: await this.formatLocationSavedMessage(realm.id, '保存しました', location) });
      return;
    }
    if (subcommand === 'edit') {
      const target = requiredOptionString(interaction, 'target');
      const field = interaction.options.getString('field', true);
      const value = interaction.options.getString('value');
      const x = interaction.options.getNumber('x');
      const y = interaction.options.getNumber('y');
      const z = interaction.options.getNumber('z');
      const clearNote = interaction.options.getBoolean('clear_note') === true;
      let patch;
      switch (field) {
        case 'name':
          patch = { name: requiredValue(value) };
          break;
        case 'coordinates':
          if (x === null || y === null || z === null) throw new Error('LOCATION_COORDINATES_REQUIRED');
          patch = { x, y, z };
          break;
        case 'dimension':
          patch = { dimension: parseDimensionRequired(value) };
          break;
        case 'note':
          if (clearNote) patch = { clearNote: true };
          else patch = { note: requiredValue(value) };
          break;
        default:
          throw new Error('LOCATION_FIELD_INVALID');
      }
      const location = this.store.updateLocation(realm.id, target, patch);
      await interaction.editReply({ content: await this.formatLocationSavedMessage(realm.id, '更新しました', location) });
      return;
    }
    throw new Error('LOCATION_SUBCOMMAND_UNKNOWN');
  }

  private waitForLocationImages(interaction: ChatInputCommandInteraction): Promise<LocationImage[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('LOCATION_IMAGES_TIMEOUT'));
      }, LOCATION_IMAGE_WAIT_MS);
      const onMessage = (message: Message): void => {
        if (message.author.bot || message.author.id !== interaction.user.id || message.channelId !== interaction.channelId) return;
        const images = collectLocationImagesFromMessage(message);
        if (images.length === 0) return;
        cleanup();
        resolve(images);
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.client.off('messageCreate', onMessage);
      };
      this.client.on('messageCreate', onMessage);
    });
  }

  private resolveCommandRealm(interaction: ChatInputCommandInteraction): RealmConfig | undefined {
    const realmId = interaction.options.getString('realm');
    if (realmId) return this.config.realms.find((realm) => realm.id === realmId);
    return this.config.realms.length === 1 ? this.config.realms[0] : undefined;
  }

  private findRealm(realmId: string): RealmConfig {
    return this.config.realms.find((realm) => realm.id === realmId) || { id: realmId };
  }

  private async sendToChannel(channelId: string, payload: DiscordMessage): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${channelId} is not a text channel`);
    }
    await channel.send({ ...payload, allowedMentions: { parse: [] } } as any);
  }

  private async onlineMessage(realmId: string, players: Player[]): Promise<string> {
    return [
      `オンライン人数：${players.length}`,
      `プレイヤー：${limit(await this.formatPlayerNames(realmId, players), 1900)}`,
    ].join('\n');
  }

  private realmMessage(realm: RealmConfig, info: RealmInfo, joinInfo: JoinInfo): string {
    return [
      `Realm名：${info.name || realm.name || `Realm ${realm.id}`}`,
      `Realm ID：${info.id}`,
      `稼働状態：${formatRealmState(info.state)}`,
      `説明：${limit(info.motd || 'なし')}`,
      `最大人数：${info.maxPlayers ?? '不明'}`,
      `難易度：${info.difficulty || '不明'}`,
      `接続ホスト：${joinInfo.host || joinInfo.address || '取得できませんでした'}`,
      `ポート：${joinInfo.port ?? '不明'}`,
      `リージョン：${joinInfo.region || 'ホスト名から判定できませんでした'}`,
    ].join('\n');
  }

  private interactionUser(interaction: ChatInputCommandInteraction, realmId: string): SavedLocation['createdBy'] {
    const link = this.config.discord.guildId
      ? this.store.getDiscordPlayerLink(this.config.discord.guildId, realmId, interaction.user.id)
      : undefined;
    return {
      id: interaction.user.id,
      name: link?.playerName || interaction.user.globalName || interaction.user.username,
      roleId: link?.roleId,
    };
  }

  private async formatPlayerNames(realmId: string, players: Player[]): Promise<string> {
    const labels = [] as string[];
    for (const player of players) labels.push(await this.formatPlayerLabel(realmId, player));
    return labels.length === 0 ? 'なし' : labels.join(', ');
  }

  private async formatPlayerLabel(realmId: string, player: Player): Promise<string> {
    const link = this.config.discord.guildId
      ? this.store.findDiscordPlayerLinkForPlayer(realmId, player, this.config.discord.guildId)
      : undefined;
    const roleName = await this.roleName(link?.roleId);
    return `${sanitizePlayerName(player.name)}（${roleName || '未紐付け'}）`;
  }

  private async formatLocationSavedMessage(realmId: string, action: string, location: SavedLocation): Promise<string> {
    const lines = [
      `保存地点を${action}。`,
      `名称：${location.name}`,
      `座標：${formatLocationCoordinates(location)}`,
      `ディメンション：${formatDimension(location.dimension)}`,
      `作成者：${await this.formatCreatedBy(realmId, location.createdBy)}`,
    ];
    if (location.note) lines.push(`備考：${limit(location.note, 500)}`);
    return lines.join('\n');
  }

  private async formatLocationShowMessage(realmId: string, location: SavedLocation): Promise<string> {
    const lines = [
      `名称：${location.name}`,
      `座標：${formatLocationCoordinates(location)}`,
      `ディメンション：${formatDimension(location.dimension)}`,
      `作成者：${await this.formatCreatedBy(realmId, location.createdBy)}`,
      `備考：${location.note ? limit(location.note, 1000) : 'なし'}`,
      '画像：',
    ];
    if (location.images.length === 0) lines.push('- なし');
    else location.images.forEach((image, index) => lines.push(`- ${index + 1}. [${image.name || `画像${index + 1}`}](${image.url})`));
    return limit(lines.join('\n'), 1950);
  }

  private async formatCreatedBy(realmId: string, createdBy: SavedLocation['createdBy']): Promise<string> {
    const link = this.config.discord.guildId
      ? this.store.getDiscordPlayerLink(this.config.discord.guildId, realmId, createdBy.id)
      : undefined;
    const roleName = await this.roleName(createdBy.roleId || link?.roleId);
    const playerName = link?.playerName || createdBy.name;
    return `${playerName}（${roleName || '未紐付け'}）`;
  }

  private async formatEventMessage(event: RealmEvent): Promise<string> {
    const playerName = event.playerName
      ? await this.formatPlayerNameByName(event.realmId, event.playerName)
      : '取得できませんでした';
    const lines = [
      limit(event.content || '内容を取得できませんでした', 1000),
      `達成者：${limit(playerName, 200)}`,
    ];
    if (event.coordinates && [event.coordinates.x, event.coordinates.y, event.coordinates.z].some((value) => value !== undefined)) {
      lines.push(`座標：${event.coordinates.x ?? '?'}, ${event.coordinates.y ?? '?'}, ${event.coordinates.z ?? '?'}`);
    }
    return lines.join('\n');
  }

  private async formatPlayerNameByName(realmId: string, playerName: string): Promise<string> {
    const link = this.config.discord.guildId
      ? this.store.findDiscordPlayerLinkForPlayerName(realmId, playerName, this.config.discord.guildId)
      : undefined;
    const roleName = await this.roleName(link?.roleId);
    return `${sanitizePlayerName(playerName)}（${roleName || '未紐付け'}）`;
  }

  private async roleName(roleId?: string): Promise<string | undefined> {
    if (!roleId || !this.config.discord.guildId) return undefined;
    const guild = await this.client.guilds.fetch(this.config.discord.guildId).catch(() => null);
    if (!guild) return undefined;
    const cached = guild.roles.cache.get(roleId);
    const role = cached || await guild.roles.fetch(roleId).catch(() => null);
    return role?.name;
  }
}

function buildCommands(realms: RealmConfig[]): Array<SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder> {
  const names = realms.length <= 25
    ? realms.map((realm) => ({ name: realm.name || `Realm ${realm.id}`, value: realm.id }))
    : [];
  const commandNames: Array<[string, string]> = [
    ['online', '現在オンラインのプレイヤーを表示します'],
    ['realm', 'Realmの基本情報と接続情報を表示します'],
  ];
  const commands = commandNames.map(([name, description]) => {
    const builder = new SlashCommandBuilder().setName(name).setDescription(description);
    builder.addStringOption((option) => {
      option.setName('realm').setDescription('対象Realm').setRequired(realms.length > 1);
      if (names.length > 0) option.addChoices(...names);
      return option;
    });
    return builder;
  });
  const location = new SlashCommandBuilder()
    .setName('location')
    .setDescription('Realmの保存地点を管理します')
    .addSubcommand((subcommand) => {
      subcommand
        .setName('save')
        .setDescription('座標を保存します')
        .addStringOption((option) => option.setName('name').setDescription('保存地点の名称').setRequired(true))
        .addNumberOption((option) => option.setName('x').setDescription('X座標').setRequired(true))
        .addNumberOption((option) => option.setName('y').setDescription('Y座標').setRequired(true))
        .addNumberOption((option) => option.setName('z').setDescription('Z座標').setRequired(true));
      addRealmOption(subcommand, names, realms.length > 1);
      addLocationSaveOptions(subcommand);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('list')
        .setDescription('保存地点を一覧表示します');
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('search')
        .setDescription('保存地点を検索します')
        .addStringOption((option) => option.setName('query').setDescription('名称または備考の検索語').setRequired(true));
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('show')
        .setDescription('保存地点の詳細を表示します')
        .addStringOption((option) => option.setName('name').setDescription('保存地点の名称').setRequired(true));
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('delete')
        .setDescription('保存地点を削除します')
        .addStringOption((option) => option.setName('name').setDescription('削除する保存地点の名称').setRequired(true));
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('edit')
        .setDescription('保存地点を編集します')
        .addStringOption((option) => option.setName('target').setDescription('編集対象の保存地点名').setRequired(true))
        .addStringOption((option) => option
          .setName('field')
          .setDescription('変更する項目')
          .setRequired(true)
          .addChoices(
            { name: '名称', value: 'name' },
            { name: '座標', value: 'coordinates' },
            { name: 'ディメンション', value: 'dimension' },
            { name: '備考', value: 'note' },
          ));
      addRealmOption(subcommand, names, realms.length > 1);
      addLocationEditOptions(subcommand);
      return subcommand;
    })
    .addSubcommandGroup((group) => group
      .setName('image')
      .setDescription('保存地点の画像を管理します')
      .addSubcommand((subcommand) => {
        subcommand
          .setName('add')
          .setDescription('保存地点に画像を追加します')
          .addStringOption((option) => option.setName('target').setDescription('保存地点の名称').setRequired(true));
        addRealmOption(subcommand, names, realms.length > 1);
        return subcommand;
      })
      .addSubcommand((subcommand) => {
        subcommand
          .setName('remove')
          .setDescription('保存地点の画像を番号で削除します')
          .addStringOption((option) => option.setName('target').setDescription('保存地点の名称').setRequired(true))
          .addIntegerOption((option) => option.setName('image_index').setDescription('showで表示された画像番号').setRequired(true));
        addRealmOption(subcommand, names, realms.length > 1);
        return subcommand;
      }));
  const player = new SlashCommandBuilder()
    .setName('player')
    .setDescription('MinecraftプレイヤーとDiscordアカウントを管理します')
    .addSubcommand((subcommand) => {
      subcommand
        .setName('link')
        .setDescription('プレイヤーと実行者を紐づけ、専用ロールを付与します')
        .addStringOption((option) => option.setName('player_name').setDescription('Minecraftプレイヤー名').setRequired(true))
        .addStringOption((option) => option.setName('role_name').setDescription('作成するロール名。省略時はDiscordアカウント名'));
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    })
    .addSubcommand((subcommand) => {
      subcommand
        .setName('unlink')
        .setDescription('プレイヤーと実行者の紐づけを解除します')
        .addStringOption((option) => option.setName('player_name').setDescription('Minecraftプレイヤー名').setRequired(true));
      addRealmOption(subcommand, names, realms.length > 1);
      return subcommand;
    });
  const monitor = new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Realm監視用アカウントの接続を管理します')
    .addSubcommand((subcommand) => subcommand.setName('login').setDescription('監視を有効化してRealmへ接続します'))
    .addSubcommand((subcommand) => subcommand.setName('logout').setDescription('監視を停止して認証を解除します'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('監視と認証の状態を表示します'));
  return [...commands, location, player, monitor];
}

function addRealmOption(
  builder: SlashCommandBuilder | SlashCommandSubcommandBuilder,
  names: Array<{ name: string; value: string }>,
  required: boolean,
): void {
  builder.addStringOption((option) => {
    option.setName('realm').setDescription('対象Realm').setRequired(required);
    if (names.length > 0) option.addChoices(...names);
    return option;
  });
}

function addLocationSaveOptions(builder: SlashCommandSubcommandBuilder): void {
  builder.addStringOption((option) => option
    .setName('dimension')
    .setDescription('ディメンション。省略時はオーバーワールド')
    .addChoices(
      { name: 'オーバーワールド', value: 'overworld' },
      { name: 'ネザー', value: 'nether' },
      { name: 'エンド', value: 'end' },
    ));
  builder.addStringOption((option) => option.setName('note').setDescription('備考'));
  addLocationImageOptions(builder);
}

function addLocationEditOptions(builder: SlashCommandSubcommandBuilder): void {
  builder.addStringOption((option) => option.setName('value').setDescription('名称・ディメンション・備考の変更後の値'))
    .addNumberOption((option) => option.setName('x').setDescription('座標のX'))
    .addNumberOption((option) => option.setName('y').setDescription('座標のY'))
    .addNumberOption((option) => option.setName('z').setDescription('座標のZ'))
    .addBooleanOption((option) => option.setName('clear_note').setDescription('備考を削除します'));
}

function addLocationImageOptions(builder: SlashCommandSubcommandBuilder): void {
  builder.addStringOption((option) => option
    .setName('image_urls')
    .setDescription('画像URL。改行またはカンマ区切りで複数指定できます'));
  for (const optionName of LOCATION_IMAGE_OPTION_NAMES) {
    builder.addAttachmentOption((option) => option.setName(optionName).setDescription('画像を添付します'));
  }
}

function requiredOptionString(interaction: ChatInputCommandInteraction, name: string): string {
  const value = interaction.options.getString(name, true).trim();
  if (!value) throw new Error('LOCATION_NAME_REQUIRED');
  return value;
}

function requiredOptionNumber(interaction: ChatInputCommandInteraction, name: string): number {
  const value = interaction.options.getNumber(name, true);
  if (!Number.isFinite(value)) throw new Error('LOCATION_COORDINATE_INVALID');
  return value;
}

function requiredOptionInteger(interaction: ChatInputCommandInteraction, name: string): number {
  const value = interaction.options.getInteger(name, true);
  if (!Number.isInteger(value)) throw new Error('LOCATION_IMAGE_INDEX_INVALID');
  return value;
}

function requiredValue(value: string | null): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error('LOCATION_VALUE_REQUIRED');
  return normalized;
}

function parseDimension(value: string | null): Dimension {
  return value ? parseDimensionRequired(value) : 'overworld';
}

function parseDimensionRequired(value: string | null): Dimension {
  const normalized = value?.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
  if (normalized === 'overworld' || normalized === 'オーバーワールド') return 'overworld';
  if (normalized === 'nether' || normalized === 'ネザー') return 'nether';
  if (normalized === 'end' || normalized === 'the_end' || normalized === 'ジ・エンド' || normalized === 'エンド') return 'the_end';
  throw new Error('LOCATION_DIMENSION_INVALID');
}

function collectLocationImages(interaction: ChatInputCommandInteraction): LocationImage[] {
  const images: LocationImage[] = [];
  for (const optionName of LOCATION_IMAGE_OPTION_NAMES) {
    const attachment = interaction.options.getAttachment(optionName);
    if (!attachment) continue;
    const contentType = attachment.contentType || undefined;
    const looksLikeImage = contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.name);
    if (!looksLikeImage) throw new Error('LOCATION_IMAGE_ONLY');
    images.push({
      url: attachment.url,
      name: attachment.name,
      contentType,
      size: attachment.size,
    });
  }
  const rawUrls = interaction.options.getString('image_urls');
  if (rawUrls) {
    for (const rawUrl of rawUrls.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean)) {
      const url = rawUrl.replace(/^<|>$/g, '');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('LOCATION_IMAGE_URL_INVALID');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('LOCATION_IMAGE_URL_INVALID');
      images.push({ url });
    }
  }
  return [...new Map(images.map((image) => [image.url, image])).values()];
}

function collectLocationImagesFromMessage(message: Message): LocationImage[] {
  const images: LocationImage[] = [];
  for (const attachment of message.attachments.values()) {
    const contentType = attachment.contentType || undefined;
    const looksLikeImage = contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.name);
    if (!looksLikeImage) continue;
    images.push({
      url: attachment.url,
      name: attachment.name,
      contentType,
      size: attachment.size,
    });
  }
  return [...new Map(images.map((image) => [image.url, image])).values()];
}

function formatLocationList(locations: SavedLocation[], title: string, searchQuery?: string): string {
  const header = searchQuery === undefined ? title : `${title}（${locations.length}件）`;
  if (locations.length === 0) return `${header}\n該当する保存地点はありません。`;
  const lines = [header];
  for (const dimension of ['overworld', 'nether', 'the_end'] as Dimension[]) {
    const inDimension = locations.filter((location) => location.dimension === dimension);
    if (inDimension.length === 0) continue;
    lines.push('', `### ${formatDimension(dimension)}`);
    for (const location of inDimension) {
      lines.push(`- ${location.name}`);
      if (searchQuery !== undefined && location.note && normalizeSearchText(location.note).includes(normalizeSearchText(searchQuery))) {
        lines.push(`  - 備考：${limit(location.note, 300)}`);
      }
    }
  }
  return limit(lines.join('\n'), 1950);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

function formatLocationCoordinates(location: SavedLocation): string {
  return `${location.x}, ${location.y}, ${location.z}`;
}

function formatDimension(dimension: Dimension): string {
  if (dimension === 'nether') return 'ネザー';
  if (dimension === 'the_end') return 'エンド';
  return 'オーバーワールド';
}

function formatLocationError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'LOCATION_NAME_ALREADY_EXISTS') return '同じ名称の保存地点が既にあります。別の名称を指定してください。';
  if (code === 'LOCATION_NOT_FOUND') return '指定された保存地点が見つかりません。';
  if (code === 'LOCATION_IMAGE_ADD_PENDING') return '同じチャンネルで画像追加処理が既に待機中です。先に画像を投稿してください。';
  if (code === 'LOCATION_IMAGES_TIMEOUT') return '60秒以内に画像が投稿されなかったため、画像追加を中止しました。';
  if (code === 'LOCATION_NAME_REQUIRED') return '保存地点の名称を指定してください。';
  if (code === 'LOCATION_COORDINATE_INVALID') return '座標には有効な数値を指定してください。';
  if (code === 'LOCATION_COORDINATES_REQUIRED') return '座標を変更する場合はX・Y・Zをすべて指定してください。';
  if (code === 'LOCATION_VALUE_REQUIRED') return '変更後の値を指定してください。';
  if (code === 'LOCATION_FIELD_INVALID') return '変更する項目が正しくありません。';
  if (code === 'LOCATION_DIMENSION_INVALID') return 'ディメンションはオーバーワールド、overworld、ネザー、nether、エンド、endのいずれかを指定してください。';
  if (code === 'LOCATION_IMAGE_ONLY') return '画像ファイルだけを添付してください。';
  if (code === 'LOCATION_IMAGE_URL_INVALID') return '画像URLにはhttpまたはhttpsのURLを指定してください。';
  if (code === 'LOCATION_IMAGES_REQUIRED') return '追加する画像を添付するか、image_urlsを指定してください。';
  if (code === 'LOCATION_IMAGE_INDEX_INVALID') return '画像番号が正しくありません。showで表示された番号を指定してください。';
  return `保存地点を処理できませんでした：${limit(code, 500)}`;
}

function formatCommandError(code: string): string {
  if (code === 'COMMAND_ROLE_REQUIRED') return 'このDiscordアカウントにはMinecraftプレイヤーとの紐づけロールがないため、コマンドを使用できません。管理者に `/player link` を依頼してください。';
  if (code === 'DISCORD_GUILD_REQUIRED') return 'ロール連携にはDISCORD_GUILD_IDの設定が必要です。';
  if (code === 'DISCORD_GUILD_INVALID') return 'このDiscordサーバーでは使用できません。';
  if (code === 'PLAYER_NAME_INVALID') return '有効なMinecraftプレイヤー名を指定してください。UUIDや内部識別子は指定できません。';
  if (code === 'PLAYER_ROLE_NAME_REQUIRED') return 'ロール名またはDiscordアカウント名を取得できませんでした。';
  if (code === 'PLAYER_ROLE_CREATE_FAILED') return '専用ロールを作成・付与できませんでした。BOTのManage Roles権限とロール階層を確認してください。';
  if (code === 'PLAYER_LINK_USER_ALREADY_EXISTS') return 'このDiscordアカウントは既にこのRealmのプレイヤーと紐づいています。';
  if (code === 'PLAYER_LINK_PLAYER_ALREADY_EXISTS') return 'このプレイヤーは既に別のDiscordアカウントと紐づいています。';
  if (code === 'PLAYER_LINK_NOT_FOUND') return '指定されたプレイヤーとの紐づけが見つかりません。';
  if (code === 'MONITOR_DISABLED') return '監視機能は無効です。`/monitor login` で監視を再開してください。';
  if (code === 'MONITOR_ACCOUNT_LOGGED_OUT') return '監視用アカウントはログアウト中です。`/monitor login` を実行してください。';
  if (code === 'MONITOR_ACCOUNT_IN_USE') return '監視用アカウントはMinecraft本体または別端末で使用中のため、BOTがRealmへログインできません。Minecraftからログアウトしてから `/monitor login` を再実行してください。';
  if (code === 'MONITOR_NOT_READY') return '監視用アカウントのRealm接続がまだ準備中です。`/monitor status` で状態を確認してください。';
  if (code === 'MONITOR_SUBCOMMAND_UNKNOWN') return 'monitorのサブコマンドが正しくありません。';
  if (code === 'PLAYER_SUBCOMMAND_UNKNOWN') return 'playerのサブコマンドが正しくありません。';
  if (code === 'REALMS_API_AUTH_REQUIRED') return '監視用アカウントの認証が必要です。`/monitor login` を実行し、表示された認証案内に従ってください。';
  return `Realm情報を取得できませんでした：${limit(code, 500)}`;
}

function formatMonitorLoginMessage(status: MonitorStatus): string {
  if (status.state === 'auth-required' && status.prompt) {
    return [
      '監視を有効化しました。監視用アカウントの認証が必要です。',
      `認証URL：${status.prompt.verificationUri}`,
      `コード：${status.prompt.userCode}`,
      '認証後、`/monitor status` で接続状態を確認してください。',
    ].join('\n');
  }
  if (status.state === 'account-in-use') return formatCommandError('MONITOR_ACCOUNT_IN_USE');
  if (status.state === 'ready') return '監視を有効化し、Realm接続を開始しました。';
  return '監視を有効化し、Realm接続を開始しました。認証が必要な場合は `/monitor status` を確認してください。';
}

function formatMonitorStatus(status: MonitorStatus): string {
  const lines = [`監視状態：${status.enabled ? '有効' : '無効'}`, `認証状態：${formatMonitorState(status.state)}`];
  if (status.state === 'auth-required' && status.prompt) {
    lines.push(`認証URL：${status.prompt.verificationUri}`, `コード：${status.prompt.userCode}`);
  }
  if (status.lastError) lines.push(`エラー：${limit(status.lastError, 500)}`);
  return lines.join('\n');
}

function formatMonitorState(state: MonitorStatus['state']): string {
  if (state === 'ready') return '接続中';
  if (state === 'connecting') return '接続処理中';
  if (state === 'auth-required') return '認証が必要';
  if (state === 'account-in-use') return 'アカウント使用中で接続失敗';
  if (state === 'error') return 'エラー';
  return '停止中';
}

function formatRealmState(state?: string): string {
  const normalized = state?.trim().toUpperCase();
  if (normalized === 'OPEN') return 'Open';
  if (normalized === 'CLOSE' || normalized === 'CLOSED') return 'Close';
  return state || '不明';
}

function resolveEventAsset(event: RealmEvent): { path: string; fileName: string } | undefined {
  const values = [event.type, event.content]
    .filter((value): value is string => Boolean(value))
    .map(normalizeEventKey);
  const asset = EVENT_ASSETS.find((candidate) => candidate.keys.some((key) => {
    const normalizedKey = normalizeEventKey(key);
    return values.some((value) => value.includes(normalizedKey));
  }));
  if (!asset) return undefined;
  const assetPath = path.join(EVENT_ASSET_DIR, asset.fileName);
  return existsSync(assetPath) ? { path: assetPath, fileName: asset.fileName } : undefined;
}

function normalizeEventKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s_\-:/.]/g, '');
}

function limit(value: string, max = 1000): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
