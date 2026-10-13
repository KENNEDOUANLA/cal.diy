import { MembershipRole, slugify } from "@calcom/platform-libraries";
import type { PlatformOAuthClient, User } from "@calcom/prisma/client";
import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { CalendarsService } from "@/platform/calendars/services/calendars.service";
import { EventTypesService_2024_04_15 } from "@/platform/event-types/event-types_2024_04_15/services/event-types.service";
import { SchedulesService_2024_04_15 } from "@/platform/schedules/schedules_2024_04_15/services/schedules.service";
import { GetManagedUsersInput } from "@/modules/oauth-clients/controllers/oauth-client-users/inputs/get-managed-users.input";
import { MembershipsRepository } from "@/modules/memberships/memberships.repository";
import { ProfilesRepository } from "@/modules/profiles/profiles.repository";
import { TokensRepository } from "@/modules/tokens/tokens.repository";
import { CreateManagedUserInput } from "@/modules/users/inputs/create-managed-user.input";
import { UpdateManagedUserInput } from "@/modules/users/inputs/update-managed-user.input";
import { UsersRepository } from "@/modules/users/users.repository";

@Injectable()
export class OAuthClientUsersService {
  private readonly logger = new Logger("OAuthClientUsersService");

  constructor(
    private readonly userRepository: UsersRepository,
    private readonly tokensRepository: TokensRepository,
    private readonly eventTypesService: EventTypesService_2024_04_15,
    private readonly schedulesService: SchedulesService_2024_04_15,
    private readonly calendarsService: CalendarsService,
    private readonly profilesRepository: ProfilesRepository,
    private readonly membershipsRepository: MembershipsRepository
  ) {}

  async createOAuthClientUser(oAuthClient: PlatformOAuthClient, body: CreateManagedUserInput) {
    const oAuthClientId = oAuthClient.id;
    const organizationId = oAuthClient.organizationId;

    const existingUser = await this.getExistingUserByEmail(oAuthClientId, body.email);
    if (existingUser) {
      throw new ConflictException(
        `User with the provided e-mail already exists. Existing user ID=${existingUser.id}`
      );
    }

    let user: User;
    if (!organizationId) {
      throw new BadRequestException(
        "You cannot create a managed user outside of an organization - the OAuth client does not belong to any organization."
      );
    } else {
      // NOTE: createNewUsersConnectToOrgIfExists (the upstream EE helper this used to call) was removed
      // in the community edition (no license gate — the implementation itself is gone, see
      // packages/platform/libraries/index.ts). It is reimplemented below using repositories that are
      // already functional and already injected in this service, mirroring the still-working
      // createOrUpdateMemberships flow used by regular signup.
      const email = OAuthClientUsersService.getOAuthUserEmail(oAuthClientId, body.email);
      const username = OAuthClientUsersService.getOrgUsername(email);

      const createdUser = await this.userRepository.create({ ...body, email }, username, oAuthClientId, true);

      await this.profilesRepository.createProfile(organizationId, createdUser.id, username);
      await this.membershipsRepository.createMembership(
        organizationId,
        createdUser.id,
        MembershipRole.MEMBER,
        true
      );

      user = await this.userRepository.update(createdUser.id, {
        name: body.name,
        locale: body.locale,
        avatarUrl: body.avatarUrl,
        bio: body.bio,
        metadata: body.metadata,
      });
    }

    const { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt } =
      await this.tokensRepository.createOAuthTokens(oAuthClientId, user.id);

    if (oAuthClient.areDefaultEventTypesEnabled) {
      await this.eventTypesService.createUserDefaultEventTypes(user.id);
    }

    if (body.timeZone) {
      const defaultSchedule = await this.schedulesService.createUserDefaultSchedule(user.id, body.timeZone);
      user.defaultScheduleId = defaultSchedule.id;
    }

    try {
      this.logger.log(`Setting default calendars in db for user with id ${user.id}`);
      await this.calendarsService.getCalendars(user.id);
    } catch (err) {
      this.logger.error(`Could not get calendars of new managed user with id ${user.id}`);
    }

    return {
      user,
      tokens: {
        accessToken,
        accessTokenExpiresAt,
        refreshToken,
        refreshTokenExpiresAt,
      },
    };
  }

  async getExistingUserByEmail(oAuthClientId: string, email: string) {
    const oAuthEmail = OAuthClientUsersService.getOAuthUserEmail(oAuthClientId, email);
    return await this.userRepository.findByEmail(oAuthEmail);
  }

  async getManagedUsers(oAuthClientId: string, queryParams: GetManagedUsersInput) {
    const { offset, limit, emails } = queryParams;

    const oAuthEmails = emails?.map((email) =>
      email.includes(oAuthClientId) ? email : OAuthClientUsersService.getOAuthUserEmail(oAuthClientId, email)
    );

    const managedUsers = await this.userRepository.findManagedUsersByOAuthClientIdAndEmails(
      oAuthClientId,
      offset ?? 0,
      limit ?? 50,
      oAuthEmails
    );

    return managedUsers;
  }

  async updateOAuthClientUser(
    oAuthClientId: string,
    userId: number,
    body: UpdateManagedUserInput,
    organizationId: number
  ) {
    if (body.email) {
      const emailWithOAuthId = OAuthClientUsersService.getOAuthUserEmail(oAuthClientId, body.email);
      body.email = emailWithOAuthId;
      const newUsername = OAuthClientUsersService.getOrgUsername(emailWithOAuthId);
      await this.userRepository.updateUsername(userId, newUsername);
      await this.profilesRepository.updateProfile(organizationId, userId, {
        username: newUsername,
      });
    }

    return this.userRepository.update(userId, body);
  }

  static getOAuthUserEmail(oAuthClientId: string, userEmail: string) {
    if (userEmail.includes(`+${oAuthClientId}@`)) {
      return userEmail;
    }
    const [username, emailDomain] = userEmail.split("@");
    return `${username}+${oAuthClientId}@${emailDomain}`;
  }

  // Derives a Profile/org-scoped username from an email address. Same slugification rule used
  // historically by getOrgUsernameFromEmail (removed with the rest of the EE invite flow) and by
  // updateOAuthClientUser just above, now shared so both call sites stay in sync.
  static getOrgUsername(email: string) {
    const [emailUser, emailDomain] = email.split("@");
    const [domainName, TLD] = emailDomain.split(".");
    return slugify(`${emailUser}-${domainName}-${TLD}`);
  }
}
