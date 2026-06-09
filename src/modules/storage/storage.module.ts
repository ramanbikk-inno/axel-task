import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { STORAGE, CloudinaryStorageService } from './storage.service';

@Module({
  imports: [ConfigModule],
  providers: [{ provide: STORAGE, useClass: CloudinaryStorageService }],
  exports: [STORAGE],
})
export class StorageModule {}
