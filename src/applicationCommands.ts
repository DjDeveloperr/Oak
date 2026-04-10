import { SlashCommandBuilder } from "discord.js";

export const OAK_CONFIG_COMMAND_NAME = "oak-config";

export function getOakApplicationCommandData(): ReturnType<
  SlashCommandBuilder["toJSON"]
>[] {
  return [
    new SlashCommandBuilder()
      .setName(OAK_CONFIG_COMMAND_NAME)
      .setDescription("Manage Oak workspaces, routes, and access")
      .setDMPermission(false)
      .addSubcommandGroup((group) =>
        group
          .setName("workspace")
          .setDescription("Manage Oak workspaces")
          .addSubcommand((subcommand) =>
            subcommand
              .setName("set")
              .setDescription("Create or update a workspace root")
              .addStringOption((option) =>
                option
                  .setName("key")
                  .setDescription("Workspace key, for example app")
                  .setRequired(true),
              )
              .addStringOption((option) =>
                option
                  .setName("root")
                  .setDescription("Absolute or relative filesystem path")
                  .setRequired(true),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("remove")
              .setDescription("Delete a workspace that has no active routes")
              .addStringOption((option) =>
                option
                  .setName("key")
                  .setDescription("Workspace key")
                  .setRequired(true),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("list")
              .setDescription("List all configured workspaces"),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("route")
          .setDescription("Map guilds and channels to workspaces")
          .addSubcommand((subcommand) =>
            subcommand
              .setName("set")
              .setDescription(
                "Assign the current guild or a channel to a workspace",
              )
              .addStringOption((option) =>
                option
                  .setName("workspace")
                  .setDescription("Workspace key")
                  .setRequired(true),
              )
              .addChannelOption((option) =>
                option
                  .setName("channel")
                  .setDescription("Optional channel override for this guild"),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("clear")
              .setDescription(
                "Remove a guild default route or channel override",
              )
              .addChannelOption((option) =>
                option
                  .setName("channel")
                  .setDescription("Optional channel override to remove"),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("list")
              .setDescription("List routes for the current guild"),
          ),
      )
      .addSubcommandGroup((group) =>
        group
          .setName("access")
          .setDescription("Manage workspace user access")
          .addSubcommand((subcommand) =>
            subcommand
              .setName("grant")
              .setDescription("Allow a user to use a workspace")
              .addStringOption((option) =>
                option
                  .setName("workspace")
                  .setDescription("Workspace key")
                  .setRequired(true),
              )
              .addUserOption((option) =>
                option
                  .setName("user")
                  .setDescription("User to allow")
                  .setRequired(true),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("revoke")
              .setDescription("Remove a user's workspace access")
              .addStringOption((option) =>
                option
                  .setName("workspace")
                  .setDescription("Workspace key")
                  .setRequired(true),
              )
              .addUserOption((option) =>
                option
                  .setName("user")
                  .setDescription("User to remove")
                  .setRequired(true),
              ),
          )
          .addSubcommand((subcommand) =>
            subcommand
              .setName("list")
              .setDescription("List the users allowed in a workspace")
              .addStringOption((option) =>
                option
                  .setName("workspace")
                  .setDescription("Workspace key")
                  .setRequired(true),
              ),
          ),
      )
      .toJSON(),
  ];
}
