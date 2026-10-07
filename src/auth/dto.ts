import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// 8 minimum; 128 maximum keeps argon2 hashing bounded.
const Password = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(8, { message: 'Password must be at least 8 characters.' })(target, key);
  MaxLength(128)(target, key);
};

export class EmailDto {
  @Transform(lower) @IsEmail() @MaxLength(254) email: string;
}

export class RegisterDto extends EmailDto {
  @Password() password: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  // Optional child code from the sign-up form; redeemed after the email is verified.
  @IsOptional() @IsString() @MaxLength(40) childCode?: string;
}

export class LoginDto extends EmailDto {
  @IsString() @IsNotEmpty() @MaxLength(128) password: string;
}

export class TokenDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token: string;
}

export class ResetPasswordDto extends TokenDto {
  @Password() password: string;
}

export class UpdateProfileDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) displayName?: string;
}

export class ChangeEmailDto {
  @IsString() @IsNotEmpty() @MaxLength(128) password: string;
  @Transform(lower) @IsEmail() @MaxLength(254) newEmail: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(128) currentPassword: string;
  @Password() newPassword: string;
}
