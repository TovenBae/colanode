import { Request, Response } from 'express';
import {
  AccountStatus,
  EmailRegisterInput,
  generateId,
  IdType,
  ApiErrorCode,
} from '@colanode/core';

import { database } from '@/data/database';
import { SelectAccount } from '@/data/schema';
import { ResponseBuilder } from '@/lib/response-builder';
import { rateLimitService } from '@/services/rate-limit-service';
import { configuration } from '@/lib/configuration';
import {
  buildLoginSuccessOutput,
  buildLoginVerifyOutput,
  generatePasswordHash,
} from '@/lib/accounts';

export const emailRegisterHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  const ip = res.locals.ip;
  const isIpRateLimited = await rateLimitService.isAuthIpRateLimitted(ip);
  if (isIpRateLimited) {
    return ResponseBuilder.tooManyRequests(res, {
      code: ApiErrorCode.TooManyRequests,
      message: 'Too many authentication attempts. Please try again later.',
    });
  }

  const input: EmailRegisterInput = req.body;
  const email = input.email.toLowerCase();

  const isEmailRateLimited =
    await rateLimitService.isAuthEmailRateLimitted(email);
  if (isEmailRateLimited) {
    return ResponseBuilder.tooManyRequests(res, {
      code: ApiErrorCode.TooManyRequests,
      message: 'Too many authentication attempts. Please try again later.',
    });
  }

  const existingAccount = await database
    .selectFrom('accounts')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();

  const password = await generatePasswordHash(input.password);

  let account: SelectAccount | null | undefined = null;

  const status =
    configuration.account.verificationType === 'automatic'
      ? AccountStatus.Active
      : AccountStatus.Unverified;

  if (existingAccount) {
    if (existingAccount.status !== AccountStatus.Pending) {
      return ResponseBuilder.badRequest(res, {
        code: ApiErrorCode.EmailAlreadyExists,
        message: 'Email already exists. Login or use another email.',
      });
    }

    account = await database
      .updateTable('accounts')
      .set({
        password: password,
        name: input.name,
        updated_at: new Date(),
        status: status,
      })
      .where('id', '=', existingAccount.id)
      .returningAll()
      .executeTakeFirst();
  } else {
    account = await database
      .insertInto('accounts')
      .values({
        id: generateId(IdType.Account),
        name: input.name,
        email: email,
        password: password,
        status: status,
        created_at: new Date(),
      })
      .returningAll()
      .executeTakeFirst();
  }

  if (!account) {
    return ResponseBuilder.badRequest(res, {
      code: ApiErrorCode.AccountCreationFailed,
      message: 'Failed to create account.',
    });
  }

  if (account.status === AccountStatus.Unverified) {
    if (configuration.account.verificationType === 'email') {
      const output = await buildLoginVerifyOutput(account);
      return ResponseBuilder.success(res, output);
    }

    return ResponseBuilder.badRequest(res, {
      code: ApiErrorCode.AccountPendingVerification,
      message:
        'Account is not verified yet. Contact your administrator to verify your account.',
    });
  }

  const output = await buildLoginSuccessOutput(account, {
    ip: res.locals.ip,
    platform: input.platform,
    version: input.version,
  });
  return ResponseBuilder.success(res, output);
};
