import { ApiProperty } from '@nestjs/swagger';

export class MessageResponseDto {
  @ApiProperty({ example: 'Registration received. Check your email to verify your account.' })
  message!: string;
}
